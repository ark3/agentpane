import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import {
	sessionKey,
	type BackendId,
	type SessionPreviewTurn,
	type SessionRef,
	type SessionSummary,
} from "$shared/protocol.ts";
import App from "./App.svelte";
import type { AgentpaneController, ControllerView } from "./controller.ts";
import { previewMessages } from "./preview.ts";
import { initialClientState, reduceServerEvent, type ClientState } from "./session-state.ts";
import { assistant, toolRead, toolResult, user } from "./render/samples.ts";

const piSession: SessionRef = { backend: "pi", id: "pi-1" };
const codexSession: SessionRef = { backend: "codex", id: "codex-1" };

function summary(
	ref: SessionRef,
	preview: string | null = null,
	overrides: Partial<SessionSummary> = {},
): SessionSummary {
	return {
		ref,
		cwd: "/work/project",
		preview,
		createdAt: null,
		updatedAt: null,
		status: "attached",
		isStreaming: false,
		...overrides,
	};
}

function state(overrides: Partial<ClientState> = {}): ClientState {
	return { ...initialClientState(), ...overrides };
}

function view(overrides: Partial<ControllerView> = {}): ControllerView {
	return {
		state: state(),
		draft: "",
		connection: "connected",
		busy: "idle",
		error: null,
		preview: null,
		...overrides,
	};
}

function previewUser(text: string): SessionPreviewTurn {
	return { role: "user", content: text };
}

function previewAssistant(text: string, backend: BackendId = "pi"): SessionPreviewTurn {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: backend === "codex" ? "openai-responses" : "anthropic-messages",
		provider: backend === "codex" ? "openai" : "anthropic",
		model: backend,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function storedTurns(messages: AgentMessage[]): SessionPreviewTurn[] {
	return messages.map((message) => {
		const { timestamp: _timestamp, ...stored } = message;
		return { ...stored, timestamp: "2026-08-20T10:00:00.000Z" } as SessionPreviewTurn;
	});
}

class FakeController implements AgentpaneController {
	created: Array<{ cwd: string; backend: BackendId }> = [];
	selected: SessionRef[] = [];
	previewed: SessionRef[] = [];
	submitted = 0;
	aborted = 0;
	compacted = 0;
	clearErrorCalls = 0;
	refreshCalls = 0;
	previewRefreshes = 0;
	started = 0;
	disposed = 0;
	notifications = 0;
	private listeners = new Set<(next: ControllerView) => void>();
	private renameListeners = new Set<(from: SessionRef, to: SessionRef) => void>();

	constructor(
		private current: ControllerView = view(),
		private readonly submissionError: string | null = null,
	) {}

	getView() {
		return this.current;
	}

	subscribe(listener: (next: ControllerView) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onRename(listener: (from: SessionRef, to: SessionRef) => void) {
		this.renameListeners.add(listener);
		return () => this.renameListeners.delete(listener);
	}

	/** Simulates the server's `renamed` event (D9): fires ahead of the state publish, as the real controller does. */
	fireRename(from: SessionRef, to: SessionRef) {
		for (const listener of this.renameListeners) listener(from, to);
	}

	async start() {
		this.started += 1;
	}

	dispose() {
		this.disposed += 1;
	}

	setDraft(text: string) {
		this.publish({ ...this.current, draft: text });
	}

	async create(cwd: string, backend: BackendId) {
		this.created.push({ cwd, backend });
	}

	async preview(ref: SessionRef) {
		this.previewed.push(ref);
	}

	/** The real attach path clears the preview and gives the session a live view. */
	async select(ref: SessionRef) {
		this.selected.push(ref);
		this.publish({
			...this.current,
			preview: null,
			state: {
				...this.current.state,
				selected: ref,
				sessions: {
					...this.current.state.sessions,
					[sessionKey(ref)]: { ref, messages: [], isStreaming: false, seq: 1, error: null, requests: [] },
				},
			},
		});
	}

	async submit() {
		this.submitted += 1;
		this.publish({ ...this.current, busy: "submitting", error: null });
		if (this.submissionError) {
			this.publish({ ...this.current, busy: "idle", error: this.submissionError });
		}
	}

	async abort() {
		this.aborted += 1;
	}

	/** Every fork the shell asked for, in order, with the images it carried. */
	forked: Array<{ ordinal: number; images: { mimeType: string; base64: string }[] | undefined }> = [];
	/** What `forkAndSubmit` resolves to -- false is "the fork never landed". */
	forkResult = true;
	/** Stands in for whatever the server does mid-fork, e.g. Pi's `renamed`. */
	onForkAndSubmit: ((ordinal: number) => void) | null = null;

	async forkAndSubmit(ordinal: number, images?: { mimeType: string; base64: string }[]) {
		this.forked.push({ ordinal, images });
		this.onForkAndSubmit?.(ordinal);
		return this.forkResult;
	}

	async compact() {
		this.compacted += 1;
	}

	async refreshSessions() {
		this.refreshCalls += 1;
	}

	async refreshPreview() {
		this.previewRefreshes += 1;
	}

	clearError() {
		this.clearErrorCalls += 1;
		this.publish({ ...this.current, error: null });
	}

	publish(next: ControllerView) {
		this.current = next;
		for (const listener of this.listeners) {
			this.notifications += 1;
			listener(next);
		}
	}
}

/**
 * `FakeController.preview` above only records the call, which the real one does
 * not: `controller.preview` publishes synchronously (`publish({ error: null })`)
 * *before* it awaits `api.preview`, so that publish lands while
 * `state.selected` is still null. Anything in `App.svelte` that re-runs on a
 * publish and keys off `selected` therefore sees its own write, and only a fake
 * that publishes the same way can expose it (OW-41).
 */
class PublishingPreviewController extends FakeController {
	override async preview(ref: SessionRef) {
		this.previewed.push(ref);
		const before = this.getView();
		this.publish({ ...before, error: null }); // synchronous, selected still null
		await Promise.resolve();
		const after = this.getView();
		this.publish({
			...after,
			state: { ...after.state, selected: ref },
			preview: { ref, turns: [] },
			error: null,
		});
	}
}

/**
 * jsdom never computes real layout, so scrollHeight/clientHeight are always 0.
 * Stub them the way a real browser's would read during a turn, so the
 * autoscroll *decision* (stick to bottom vs. respect a scrolled-up reader) is
 * pinned by a test. The actual pixel behavior is verified live (OW-27).
 */
function mockScrollMetrics(el: Element, metrics: { scrollHeight: number; clientHeight: number }): void {
	Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
	Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
}

/**
 * `getBoundingClientRect().top` fixed at a given position *within the
 * scrollable content* (not the viewport) -- `App.svelte`'s `anchorTop` helper
 * combines this with `el`'s own rect and `scrollTop` to recover that content
 * position, so a `contentTop` mock here round-trips through the real formula
 * exactly as a real element whose position in the content never moves would.
 */
function mockContentTop(el: HTMLElement, scrollParent: HTMLElement, contentTop: number): void {
	const rect = (top: number) => ({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
	Object.defineProperty(el, "getBoundingClientRect", {
		value: () => rect(contentTop - scrollParent.scrollTop),
		configurable: true,
	});
}

/**
 * Fix each rendered user turn at a known position within the scrollable content
 * (OW-60). The rail's target selection is entirely a function of where the user
 * turns sit relative to `scrollTop`, and jsdom puts every one of them at 0, so
 * without this there is no geometry to select against at all.
 */
function placeUserTurns(el: HTMLElement, tops: number[]): HTMLElement[] {
	const turns = Array.from(el.querySelectorAll<HTMLElement>('[data-role="user"]'));
	if (turns.length !== tops.length) throw new Error(`expected ${tops.length} user turns, rendered ${turns.length}`);
	turns.forEach((turn, i) => mockContentTop(turn, el, tops[i]!));
	return turns;
}

/** App.svelte's follow-mode reconciliation is rAF-throttled while streaming (same pattern as Block.test.ts). */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

describe("App", () => {
	it("starts once, disposes once, and stops observing the controller when unmounted", () => {
		const controller = new FakeController();
		const { unmount } = render(App, { props: { controller } });

		expect(controller.started).toBe(1);
		unmount();
		expect(controller.disposed).toBe(1);

		controller.publish(view({ connection: "reconnecting" }));
		expect(controller.notifications).toBe(0);
	});

	it("creates a new session in the selected session's workspace with the chosen backend", async () => {
		const controller = new FakeController(view({
			state: state({ selected: piSession, summaries: [summary(piSession, "P", { cwd: "/work/project" })] }),
		}));
		render(App, { props: { controller } });

		await fireEvent.change(screen.getByLabelText("Backend"), { target: { value: "codex" } });
		await fireEvent.click(screen.getByRole("button", { name: "New" }));

		expect(controller.created).toEqual([{ cwd: "/work/project", backend: "codex" }]);
	});

	it("disables New session when there is no selected workspace to inherit", () => {
		const controller = new FakeController();
		render(App, { props: { controller } });

		expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
	});

	it("places the New session button in the same row as the Backend selector", () => {
		const controller = new FakeController();
		render(App, { props: { controller } });

		const button = screen.getByRole("button", { name: "New" });
		const select = screen.getByLabelText("Backend");
		expect(button.parentElement).toBe(select.parentElement?.parentElement);
	});

	/**
	 * The three tests below reach the menu's entries with `hidden: true`, and
	 * without opening the menu first, because jsdom implements none of the
	 * Popover API the menu is now built on (OW-80) while still applying the UA
	 * rule that hides a `[popover]`: `showPopover` is `undefined`, a
	 * `popovertarget` click is a no-op, and the entries are therefore
	 * permanently `display: none` and out of the accessibility tree. What each
	 * one asserts is unchanged. That the menu *dismisses* is the part jsdom
	 * cannot host at all, and it lives in `e2e/tools-menu.spec.ts`.
	 */
	it("the composer's New conversation inherits the selected session's workspace AND backend (OW-72)", async () => {
		// Unlike the configured New button (which reads the two selects), this
		// entry inherits the selected session's own backend. The selected session
		// is codex; the backend select stays on its default. Inheriting the
		// backend is what this asserts -- so the created backend is codex, not the
		// select's value.
		const controller = new FakeController(view({
			state: state({
				selected: codexSession,
				summaries: [summary(codexSession, "C", { cwd: "/work/project" })],
			}),
		}));
		render(App, { props: { controller } });

		await fireEvent.click(screen.getByRole("menuitem", { name: "New conversation", hidden: true }));

		expect(controller.created).toEqual([{ cwd: "/work/project", backend: "codex" }]);
	});

	it("disables the composer's New conversation and Compact when nothing is selected (OW-72)", () => {
		const controller = new FakeController();
		render(App, { props: { controller } });

		expect(screen.getByRole("menuitem", { name: "New conversation", hidden: true })).toBeDisabled();
		expect(screen.getByRole("menuitem", { name: "Compact", hidden: true })).toBeDisabled();
	});

	it("the composer's Compact tool compacts the selected session (OW-72)", async () => {
		const controller = new FakeController(view({
			state: state({ selected: piSession, summaries: [summary(piSession, "P")] }),
		}));
		render(App, { props: { controller } });

		await fireEvent.click(screen.getByRole("menuitem", { name: "Compact", hidden: true }));

		expect(controller.compacted).toBe(1);
	});

	it("previews a stored session on row selection instead of attaching, labelling it by backend and id", async () => {
		const controller = new FakeController(view({
			state: state({ summaries: [summary(piSession, "Review the patch"), summary(codexSession)] }),
		}));
		render(App, { props: { controller } });
		await tick();
		controller.previewed.length = 0; // discard the startup auto-select

		// Prefix match: an attached row's accessible name carries a trailing
		// "(attached)" (OW-lepoki), and what this test is about is the label's text.
		await fireEvent.click(screen.getByRole("button", { name: /^Review the patch/ }));

		expect(controller.previewed).toEqual([piSession]);
		expect(controller.selected).toEqual([]); // a row click never spawns via attach
		expect(screen.getByRole("button", { name: /^codex codex-1/ })).toBeInTheDocument();
	});

	it("labels a just-prompted session by its own first user message while the server preview is still null", async () => {
		// The real SSE order for a first prompt on a virtual Pi session
		// (broadcaster.ts): sessions-changed, renamed, then the snapshot for the
		// new ref. Replayed through the real reducer rather than hand-assembled,
		// so the end state is the one the client would actually hold.
		const virtualRef: SessionRef = { backend: "pi", id: "virtual:abc" };
		const realRef: SessionRef = { backend: "pi", id: "/home/u/.pi/sessions/abc.jsonl" };

		let current = state();
		const changed = reduceServerEvent(current, { type: "sessions-changed" });
		expect(changed.refreshSessions).toBe(true);
		// The refresh it asks for reads the list *before* the JSONL has the user
		// turn, so preview comes back null -- that is the whole bug.
		current = { ...changed.state, summaries: [summary(virtualRef, null)] };
		current = reduceServerEvent(current, { type: "renamed", session: realRef, seq: 1, from: virtualRef }).state;
		current = reduceServerEvent(current, {
			type: "snapshot",
			session: realRef,
			seq: 2,
			messages: [user("Explain the crash")],
			isStreaming: false,
			compaction: null,
		}).state;

		const controller = new FakeController(view({ state: current }));
		render(App, { props: { controller } });
		await tick();

		const row = screen.getByRole("button", { name: /^Explain the crash/ });
		expect(within(row).getByText("Explain the crash")).toHaveClass("session-preview");
		expect(
			screen.queryByRole("button", { name: (name) => name.startsWith(`pi ${realRef.id}`) }),
		).not.toBeInTheDocument();
	});

	it("auto-selects the most recent session in scope on startup", async () => {
		const older = summary(piSession, "Older", { updatedAt: "2026-01-01T00:00:00.000Z" });
		const newer = summary(codexSession, "Newer", { updatedAt: "2026-06-01T00:00:00.000Z" });
		const controller = new FakeController(view({ state: state({ summaries: [older, newer] }) }));
		render(App, { props: { controller } });
		await tick();

		expect(controller.previewed).toEqual([codexSession]);
	});

	it("auto-selects exactly once when preview publishes before it resolves", async () => {
		const controller = new PublishingPreviewController(
			view({ state: state({ summaries: [summary(piSession, "Stored")] }) }),
		);
		render(App, { props: { controller } });
		await tick();
		await tick();

		// Without a per-ref guard the effect re-fires on preview's own synchronous
		// publish (selected is still null) until Svelte's depth guard throws.
		expect(controller.previewed).toEqual([piSession]);
	});

	it("re-selects the most recent session in scope when the workspace filter changes", async () => {
		const projectA: SessionRef = { backend: "pi", id: "a" };
		const projectB: SessionRef = { backend: "pi", id: "b" };
		const projectAgain: SessionRef = { backend: "pi", id: "c" };
		const controller = new FakeController(view({
			state: state({
				summaries: [
					summary(projectA, "A", { cwd: "/work/a", updatedAt: "2026-01-01T00:00:00.000Z" }),
					summary(projectB, "B", { cwd: "/work/b", updatedAt: "2026-02-01T00:00:00.000Z" }),
					summary(projectAgain, "C", { cwd: "/work/a", updatedAt: "2026-03-01T00:00:00.000Z" }),
				],
			}),
		}));
		render(App, { props: { controller } });
		await tick();
		// Default (all) auto-selected the most recent overall.
		expect(controller.previewed).toEqual([projectAgain]);
		controller.previewed.length = 0;

		await fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "/work/b" } });
		await tick();

		expect(controller.previewed).toEqual([projectB]);
	});

	it("swaps the composer for an Attach button while previewing, opens the live session, and focuses the prompt", async () => {
		const controller = new FakeController(view({
			state: state({ selected: piSession, summaries: [summary(piSession, "Stored")] }),
			preview: { ref: piSession, turns: [previewUser("earlier question")] },
		}));
		render(App, { props: { controller } });
		await tick();

		// Read-only: the preview turn shows, the composer is replaced by Attach.
		expect(screen.getByText("earlier question")).toBeInTheDocument();
		expect(screen.queryByLabelText("Prompt")).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Attach" }));
		expect(controller.selected).toEqual([piSession]);

		await tick();
		await tick();
		expect(screen.getByLabelText("Prompt")).toHaveFocus();
	});

	it("renders a preview through the same transcript DOM as an attached session", async () => {
		// The point of mapping preview turns to messages (OW-50): one renderer,
		// so the two paths cannot drift. Same content in, same DOM out.
		const turns: SessionPreviewTurn[] = [
			previewUser("earlier question"),
			previewAssistant("earlier answer"),
		];
		const previewed = render(App, {
			props: {
				controller: new FakeController(view({
					state: state({ selected: piSession, summaries: [summary(piSession, "Stored")] }),
					preview: { ref: piSession, turns },
				})),
			},
		});
		await tick();
		const previewDom = previewed.container.querySelector(".transcript")?.innerHTML;

		const attached = render(App, {
			props: {
				controller: new FakeController(view({
					state: state({
						selected: piSession,
						summaries: [summary(piSession, "Stored")],
						sessions: {
							[sessionKey(piSession)]: {
								ref: piSession,
								messages: previewMessages(turns),
								isStreaming: false,
								seq: 1,
								error: null,
								requests: [],
							},
						},
					}),
				})),
			},
		});
		await tick();
		const attachedEl = attached.container.querySelector(".transcript") as HTMLElement;

		expect(previewDom).toBeTruthy();
		// One deliberate difference, and only this one: a preview has no composer,
		// so it offers no edit control (OW-hezidi). Strip those and the two paths
		// have to be byte-identical again -- that is the "one renderer" claim.
		expect(attachedEl.querySelectorAll("[data-edit]")).toHaveLength(1);
		expect(previewed.container.querySelectorAll("[data-edit]")).toHaveLength(0);
		for (const button of attachedEl.querySelectorAll("[data-edit]")) button.remove();
		expect(previewDom).toBe(attachedEl.innerHTML);
	});

	it("labels a previewed turn like the transcript does (no role label) and attributes it to the backend", async () => {
		const controller = new FakeController(view({
			state: state({ selected: codexSession, summaries: [summary(codexSession, "Stored")] }),
			preview: {
				ref: codexSession,
				turns: [
					previewUser("earlier question"),
					previewAssistant("earlier answer", "codex"),
				],
			},
		}));
		const { container } = render(App, { props: { controller } });
		await tick();

		const conversation = within(screen.getByRole("region", { name: "Conversation" }));
		// Neither role is labelled -- the transcript never labels a turn (OW-52).
		expect(conversation.queryByText("You")).not.toBeInTheDocument();
		expect(conversation.queryByText("Agent")).not.toBeInTheDocument();
		// The backend id is the one identity a preview knows, and it shows.
		expect(container.querySelector("[data-role='assistant'] .meta")?.textContent).toContain("codex");
	});

	it("uses the transcript empty state when the stored session has no messages", async () => {
		const controller = new FakeController(view({
			state: state({ selected: piSession, summaries: [summary(piSession, "Stored")] }),
			preview: { ref: piSession, turns: [] },
		}));
		const { container } = render(App, { props: { controller } });
		await tick();

		expect(screen.getByText("No messages yet.")).toBeInTheDocument();
		expect(container.querySelector(".transcript")).not.toBeNull();
	});

	it("orders sessions by recency, most recently updated first", () => {
		const older = summary(piSession, "Older", { updatedAt: "2026-01-01T00:00:00.000Z" });
		const newer = summary(codexSession, "Newer", { updatedAt: "2026-06-01T00:00:00.000Z" });
		const controller = new FakeController(view({ state: state({ summaries: [older, newer] }) }));
		render(App, { props: { controller } });

		const previews = screen
			.getByRole("navigation", { name: "Sessions" })
			.querySelectorAll(".session-preview");
		expect(Array.from(previews).map((node) => node.textContent)).toEqual(["Newer", "Older"]);
	});

	it("shows each session's backend, its workspace, and a second-precision timestamp", () => {
		const controller = new FakeController(view({
			state: state({
				summaries: [
					summary(piSession, "Same preview", { cwd: "/work/project", updatedAt: "2026-06-01T12:34:56.000Z" }),
				],
			}),
		}));
		render(App, { props: { controller } });
		const nav = within(screen.getByRole("navigation", { name: "Sessions" }));

		expect(nav.getByText("pi")).toBeInTheDocument();
		expect(nav.getByText("project")).toBeInTheDocument();
		expect(nav.getByText("2026-06-01 18:04:56")).toBeInTheDocument();
	});

	it("shows the workspace basename rather than the full cwd in the session list and workspace dropdown, with the full path as title", () => {
		const controller = new FakeController(view({
			state: state({
				summaries: [summary(piSession, "Same preview", { cwd: "/work/deep/project" })],
			}),
		}));
		render(App, { props: { controller } });
		const nav = within(screen.getByRole("navigation", { name: "Sessions" }));

		const cwdEl = nav.getByText("project");
		expect(cwdEl).toHaveAttribute("title", "/work/deep/project");
		expect(nav.queryByText("/work/deep/project")).not.toBeInTheDocument();

		const option = screen.getByRole("option", { name: "project" }) as HTMLOptionElement;
		expect(option.value).toBe("/work/deep/project");
		expect(option).toHaveAttribute("title", "/work/deep/project");
	});

	it("color-codes the backend badge per backend, with an unrecognised backend id falling back to grey", () => {
		const claudeSession: SessionRef = { backend: "claude", id: "claude-1" };
		const unknownSession: SessionRef = { backend: "future" as BackendId, id: "future-1" };
		const controller = new FakeController(view({
			state: state({
				summaries: [
					summary(piSession, "Pi turn"),
					summary(codexSession, "Codex turn"),
					summary(claudeSession, "Claude turn"),
					summary(unknownSession, "Future turn"),
				],
			}),
		}));
		const { container } = render(App, { props: { controller } });

		const badges = Array.from(container.querySelectorAll<HTMLElement>(".session-backend"));
		const colors = new Map(badges.map((badge) => [badge.textContent, badge.style.color]));

		expect(colors.get("pi")).toBe("var(--ap-backend-pi)");
		expect(colors.get("codex")).toBe("var(--ap-backend-codex)");
		expect(colors.get("claude")).toBe("var(--ap-backend-claude)");
		expect(colors.get("future")).toBe("var(--ap-fg-subtle)");
	});

	it("shows a streaming indicator only for a session that is streaming", () => {
		const idle = summary(piSession, "Idle turn", { isStreaming: false });
		const live = summary(codexSession, "Live turn", { isStreaming: true });
		const controller = new FakeController(view({ state: state({ summaries: [idle, live] }) }));
		render(App, { props: { controller } });
		const nav = within(screen.getByRole("navigation", { name: "Sessions" }));

		expect(nav.queryByLabelText("Streaming")).toBeInTheDocument();
		expect(nav.getAllByLabelText("Streaming")).toHaveLength(1);
	});

	/**
	 * The summary's `isStreaming` dates from the last list read and no live event
	 * updates it (OW-furinu). The live map does, so the row prefers it -- in both
	 * directions, since a dot that latches on is the same defect wearing the
	 * other sign.
	 */
	it("takes the row's dot from the live session map rather than the listed summary", () => {
		const stale = summary(piSession, "Live turn", { isStreaming: false });
		const controller = new FakeController(
			view({
				state: state({
					summaries: [stale],
					sessions: {
						[sessionKey(piSession)]: {
							ref: piSession,
							messages: [],
							isStreaming: true,
							seq: 1,
							error: null,
							requests: [],
						},
					},
				}),
			}),
		);
		render(App, { props: { controller } });
		const nav = within(screen.getByRole("navigation", { name: "Sessions" }));

		expect(nav.queryByLabelText("Streaming")).toBeInTheDocument();
	});

	it("clears the row's dot when the live session map says the turn ended", () => {
		const stale = summary(piSession, "Ended turn", { isStreaming: true });
		const controller = new FakeController(
			view({
				state: state({
					summaries: [stale],
					sessions: {
						[sessionKey(piSession)]: {
							ref: piSession,
							messages: [],
							isStreaming: false,
							seq: 1,
							error: null,
							requests: [],
						},
					},
				}),
			}),
		);
		render(App, { props: { controller } });
		const nav = within(screen.getByRole("navigation", { name: "Sessions" }));

		expect(nav.queryByLabelText("Streaming")).not.toBeInTheDocument();
	});

	it("stripes the row of an attached session, and says so in its accessible name", () => {
		const attached = summary(piSession, "Attached turn", { status: "attached" });
		const detached = summary(codexSession, "Detached turn", { status: "detached" });
		const controller = new FakeController(view({ state: state({ summaries: [attached, detached] }) }));
		const { container } = render(App, { props: { controller } });
		const rows = Array.from(container.querySelectorAll<HTMLElement>(".session-select"));

		const attachedRow = rows.find((row) => row.textContent?.includes("Attached turn"));
		const detachedRow = rows.find((row) => row.textContent?.includes("Detached turn"));

		/* The class, not a computed style: jsdom resolves neither the token nor
		   the inset shadow, and the stripe's look is a verdict for the owner. */
		expect(attachedRow?.classList.contains("session-attached")).toBe(true);
		expect(detachedRow?.classList.contains("session-attached")).toBe(false);

		expect(attachedRow).toHaveAttribute("aria-label", "Attached turn (attached)");
		expect(detachedRow).toHaveAttribute("aria-label", "Detached turn");
	});

	it("invokes refreshSessions from the sessions header refresh control", async () => {
		const controller = new FakeController(view());
		render(App, { props: { controller } });

		await fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

		expect(controller.refreshCalls).toBe(1);
	});

	it("does not offer a way to close or disconnect a session from the UI (D12 owns reclamation)", () => {
		const controller = new FakeController(view({
			state: state({ summaries: [summary(piSession, "Live", { status: "attached" })] }),
		}));
		render(App, { props: { controller } });

		expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
	});

	it("shows an empty transcript until the selected session has messages", () => {
		const controller = new FakeController();
		render(App, { props: { controller } });

		expect(screen.getByText("No messages yet.")).toBeInTheDocument();
	});

	it("renders the selected session transcript", async () => {
		const messages: AgentMessage[] = [user("Explain this change")];
		const controller = new FakeController(view({
			state: state({
				selected: piSession,
				sessions: {
					"pi:pi-1": {
						ref: piSession,
						messages,
						isStreaming: false,
						seq: 1,
						error: null,
						requests: [],
					},
				},
			}),
		}));
		render(App, { props: { controller } });
		await tick();

		expect(screen.getByText("Explain this change")).toBeInTheDocument();
	});

	it("hides tool and thinking chrome behind the reading view toggle, and restores it", async () => {
		const controller = new FakeController(view({
			state: state({
				selected: piSession,
				sessions: {
					"pi:pi-1": { ref: piSession, messages: toolRead, isStreaming: false, seq: 1, error: null, requests: [] },
				},
			}),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();
		const toggle = screen.getByRole("button", { name: "Reading view" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(container.querySelector("details.tool")).not.toBeNull();
		expect(container.querySelector("details.thinking")).not.toBeNull();

		await fireEvent.click(toggle);
		await tick();

		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(container.querySelector("details.tool")).toBeNull();
		expect(container.querySelector("details.thinking")).toBeNull();
		// The prose on both sides of the elided turn is exactly what survives.
		expect(screen.getByText(/Read greeting.txt/)).toBeInTheDocument();
		expect(screen.getByText(/quick brown fox jumps over a lazy dog/)).toBeInTheDocument();
		// And the surviving entries still carry their *original* message index:
		// follow mode finds its anchor by this attribute (reconcile), and the
		// closing assistant turn is message 3 even though 1 and 2 are gone.
		expect(container.querySelector('[data-index="0"]')?.getAttribute("data-role")).toBe("user");
		expect(container.querySelector('[data-index="3"]')?.getAttribute("data-role")).toBe("assistant");

		await fireEvent.click(toggle);
		await tick();

		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(container.querySelector("details.tool")).not.toBeNull();
		expect(container.querySelector("details.thinking")).not.toBeNull();
	});

	it("keeps the reading view toggle visible while previewing", async () => {
		const turns = storedTurns(toolRead);
		const controller = new FakeController(view({
			state: state({ selected: piSession, summaries: [summary(piSession, "Stored")] }),
			preview: { ref: piSession, turns },
		}));
		const { container } = render(App, { props: { controller } });
		await tick();

		const toggle = screen.getByRole("button", { name: "Reading view" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(container.querySelector("details.tool")).not.toBeNull();
		expect(container.querySelector("details.thinking")).not.toBeNull();

		await fireEvent.click(toggle);
		await tick();

		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(container.querySelector("details.tool")).toBeNull();
		expect(container.querySelector("details.thinking")).toBeNull();

		await fireEvent.click(toggle);
		await tick();

		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(container.querySelector("details.tool")).not.toBeNull();
		expect(container.querySelector("details.thinking")).not.toBeNull();
	});

	it("restores each session's own scroll position when switching, and scrolls a fresh one to the tail", async () => {
		const sessions = {
			"pi:pi-1": { ref: piSession, messages: [], isStreaming: false, seq: 1, error: null, requests: [] },
			"codex:codex-1": { ref: codexSession, messages: [], isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		// The reader scrolls away from the tail on session A.
		mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 500 });
		el.scrollTop = 50;
		await fireEvent.scroll(el);

		// Session B has no scroll memory yet -- it lands at its own tail. 200,
		// not 700: the tail is scrollHeight - clientHeight, and `applyScrollTop`
		// clamps to it. jsdom would have accepted the un-clamped 700 that no
		// browser ever holds, and accepting it stranded `suppressScrollHandling`
		// on an assignment the browser turned into a no-op (OW-60).
		mockScrollMetrics(el, { scrollHeight: 700, clientHeight: 500 });
		controller.publish(view({ state: state({ selected: codexSession, sessions }) }));
		await tick();
		expect(el.scrollTop).toBe(200);

		// Switching back to A restores its remembered, scrolled-up position.
		mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 500 });
		controller.publish(view({ state: state({ selected: piSession, sessions }) }));
		await tick();
		expect(el.scrollTop).toBe(50);
	});

	it("keeps following through a submit whose echoed message and assistant placeholder both arrive before their status:true (D2: cross-event ordering is not guaranteed)", async () => {
		const old = user("old message");
		const sessions = {
			"pi:pi-1": { ref: piSession, messages: [old], isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({
			draft: "New prompt",
			state: state({ selected: piSession, sessions }),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);

		// The echoed user message arrives first -- isStreaming still false,
		// exactly as it would before the assistant itself has started.
		const submittedMessage = user("New prompt");
		mockScrollMetrics(el, { scrollHeight: 560, clientHeight: 500 });
		controller.publish(view({
			draft: "",
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: false } },
			}),
		}));
		await tick();
		// Anchor's position within the content is fixed far below any cap this
		// test would hit, so this stays a pure tracking case throughout.
		const anchorEl = el.querySelector('[data-index="1"]') as HTMLElement;
		mockContentTop(anchorEl, el, 5000);

		// The assistant's own placeholder lands next -- still isStreaming:false.
		const placeholder = assistant([], "pending");
		mockScrollMetrics(el, { scrollHeight: 620, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage, placeholder], isStreaming: false } },
			}),
		}));
		await tick();

		// Only now does status:true arrive.
		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage, placeholder], isStreaming: true } },
			}),
		}));
		await tick();
		await nextFrame();

		// Follow must still be armed -- the two false-streaming upserts before
		// this one must not have silently disarmed it.
		expect(el.scrollTop).toBe(400); // scrollHeight(900) - clientHeight(500)
	});

	it("keeps following across a virtual session's rename on its first submit (D9: every new session gets one)", async () => {
		const virtualSession: SessionRef = { backend: "pi", id: "virtual:1" };
		const realSession: SessionRef = { backend: "pi", id: "pi-77" };
		const sessions = {
			"pi:virtual:1": { ref: virtualSession, messages: [], isStreaming: false, seq: null, error: null, requests: [] },
		};
		const controller = new FakeController(view({
			draft: "First prompt",
			state: state({ selected: virtualSession, sessions }),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		expect(controller.submitted).toBe(1);

		// The server accepts the prompt and, in the same tick, renames the
		// session (virtual -> real) before its snapshot/upsert events arrive.
		controller.fireRename(virtualSession, realSession);
		const submittedMessage = user("First prompt");
		mockScrollMetrics(el, { scrollHeight: 560, clientHeight: 500 });
		controller.publish(view({
			draft: "",
			state: state({
				selected: realSession,
				sessions: {
					"pi:pi-77": { ref: realSession, messages: [submittedMessage], isStreaming: false, seq: 1, error: null, requests: [] },
				},
			}),
		}));
		await tick();
		const anchorEl = el.querySelector('[data-index="0"]') as HTMLElement;
		mockContentTop(anchorEl, el, 5000);

		// The assistant streams a reply under the new (post-rename) key.
		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: realSession,
				sessions: {
					"pi:pi-77": { ref: realSession, messages: [submittedMessage], isStreaming: true, seq: 2, error: null, requests: [] },
				},
			}),
		}));
		await tick();
		await nextFrame();

		// Follow must have engaged despite the rename -- if pendingFollow/sessionScroll
		// were still keyed under the pre-rename "pi:virtual:1", this would read 0
		// (jumped-and-stuck) instead of tracking to the tail.
		expect(el.scrollTop).toBe(400); // scrollHeight(900) - clientHeight(500)
	});

	it("re-arms follow on submit even after the reader had scrolled away, tracks growth, and locks once the submitted message would be pushed off the top", async () => {
		const old = user("old message");
		const sessions = {
			"pi:pi-1": { ref: piSession, messages: [old], isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({
			draft: "New prompt",
			state: state({ selected: piSession, sessions }),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		// The reader had scrolled away from the tail before submitting.
		mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 500 });
		el.scrollTop = 50;
		await fireEvent.scroll(el);

		// Submitting arms follow -- unconditionally, regardless of that scroll.
		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		expect(controller.submitted).toBe(1);

		// The submitted message lands (simulating the resulting SSE upsert). Its
		// position within the scrollable content is fixed at 400px from the top
		// and never moves as later content grows below it -- exactly what a real
		// message that finished rendering and isn't itself changing would do.
		const submittedMessage = user("New prompt");
		const anchorContentTop = 400;
		mockScrollMetrics(el, { scrollHeight: 560, clientHeight: 500 });
		controller.publish(view({
			draft: "",
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true } },
			}),
		}));
		await tick();
		const anchorEl = el.querySelector('[data-index="1"]') as HTMLElement;
		expect(anchorEl).toBeTruthy();
		mockContentTop(anchorEl, el, anchorContentTop);
		// The mock above only takes effect on the *next* reconcile -- force one
		// the same way a further upsert would.
		mockScrollMetrics(el, { scrollHeight: 560, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true } },
			}),
		}));
		await tick();
		await nextFrame(); // reconcile() is rAF-throttled while streaming
		expect(el.scrollTop).toBe(60); // scrollHeight(560) - clientHeight(500): tracking, well short of the 400px cap.

		// The response grows below the anchor; still short of the cap, so it keeps tracking.
		mockScrollMetrics(el, { scrollHeight: 700, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true } },
			}),
		}));
		await tick();
		await nextFrame();
		expect(el.scrollTop).toBe(200);

		// It grows past the point where the anchor's own top would leave the viewport: locks at the cap.
		mockScrollMetrics(el, { scrollHeight: 1100, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true } },
			}),
		}));
		await tick();
		await nextFrame();
		expect(el.scrollTop).toBe(anchorContentTop);

		// Further growth does not push the anchor off-screen -- it stays locked.
		mockScrollMetrics(el, { scrollHeight: 1400, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true } },
			}),
		}));
		await tick();
		await nextFrame();
		expect(el.scrollTop).toBe(anchorContentTop);

		// A manual scroll disengages follow -- later growth no longer chases it.
		el.scrollTop = 50;
		await fireEvent.scroll(el);
		mockScrollMetrics(el, { scrollHeight: 1800, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true } },
			}),
		}));
		await tick();
		expect(el.scrollTop).toBe(50);
	});

	it("stops following once the turn ends, even without a manual scroll", async () => {
		const old = user("old message");
		const submittedMessage = user("New prompt");
		const initial = {
			"pi:pi-1": { ref: piSession, messages: [old], isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({
			draft: "New prompt",
			state: state({ selected: piSession, sessions: initial }),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		// Submitting arms follow for whatever message this submission produces
		// -- it does not exist in the transcript yet, matching the real
		// submit-then-SSE-upsert ordering (D2).
		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		const sessions = {
			"pi:pi-1": { ...initial["pi:pi-1"], messages: [old, submittedMessage], isStreaming: true },
		};
		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({
			draft: "",
			state: state({ selected: piSession, sessions }),
		}));
		await tick();
		const anchorEl = el.querySelector('[data-index="1"]') as HTMLElement;
		mockContentTop(anchorEl, el, 5000); // far below any cap, so this is a pure tracking case.
		// The mock above only takes effect on the *next* reconcile -- force one.
		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({ state: state({ selected: piSession, sessions }) }));
		await tick();
		await nextFrame();
		expect(el.scrollTop).toBe(400); // scrollHeight(900) - clientHeight(500)

		// The turn ends; nothing left to chase.
		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], isStreaming: false } },
			}),
		}));
		await tick();

		// A hypothetical later change (e.g. a fork-in prior turn) no longer autoscrolls this session.
		mockScrollMetrics(el, { scrollHeight: 1300, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], isStreaming: false, messages: [old, submittedMessage, user("later")] } },
			}),
		}));
		await tick();
		expect(el.scrollTop).toBe(400); // unchanged -- follow did not resume
	});

	it("steps the rail between user turns from the first one at or below the viewport top, skipping however many assistant and tool messages sit between them", async () => {
		// Three user turns, but seven messages: the gaps between them are filled
		// with the assistant/tool chrome a real turn produces. A rail that
		// stepped by message, or by DOM sibling, would land in the middle of one.
		const messages = [
			user("first"),
			assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], "toolUse"),
			toolResult("c1", "bash", "output"),
			assistant([{ type: "text", text: "an answer" }], "stop"),
			user("second"),
			assistant([{ type: "text", text: "another answer" }], "stop"),
			user("third"),
		];
		const sessions = {
			"pi:pi-1": { ref: piSession, messages, isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		mockScrollMetrics(el, { scrollHeight: 2600, clientHeight: 500 });
		expect(placeUserTurns(el, [0, 1000, 2000])).toHaveLength(3);
		// One non-user landmark per gap and then some, so "skips them" is a real
		// claim here. Three, not four: the toolResult renders inside its
		// toolCall's block rather than as a landmark of its own.
		expect(el.querySelectorAll('[data-index]:not([data-role="user"])')).toHaveLength(3);

		el.scrollTop = 0;
		await fireEvent.scroll(el);
		await tick();

		// Pivot is the first user turn (top 0, at the viewport top): nothing before it.
		await fireEvent.click(screen.getByRole("button", { name: "Next user message" }));
		expect(el.scrollTop).toBe(1000);
		await fireEvent.click(screen.getByRole("button", { name: "Next user message" }));
		expect(el.scrollTop).toBe(2000);

		// And back the same way -- each jump parks its target on the viewport
		// top, so the target itself becomes the pivot for the next step.
		await fireEvent.click(screen.getByRole("button", { name: "Previous user message" }));
		expect(el.scrollTop).toBe(1000);
		await fireEvent.click(screen.getByRole("button", { name: "Previous user message" }));
		expect(el.scrollTop).toBe(0);
	});

	it("keeps the rail present at all times and disables only the directions the reader cannot go", async () => {
		const messages = [user("first"), assistant([{ type: "text", text: "a" }], "stop"), user("second")];
		const sessions = {
			"pi:pi-1": { ref: piSession, messages, isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;
		const rail = () => ({
			start: screen.getByRole("button", { name: "Jump to start" }),
			prev: screen.getByRole("button", { name: "Previous user message" }),
			next: screen.getByRole("button", { name: "Next user message" }),
			end: screen.getByRole("button", { name: "Jump to end" }),
		});

		// scrollHeight(2600) - clientHeight(500) = 2100, well past the last user
		// turn at 2000: `start`/`end` are the scroller's true ends, not turns.
		mockScrollMetrics(el, { scrollHeight: 2600, clientHeight: 500 });
		placeUserTurns(el, [0, 2000]);
		el.scrollTop = 0;
		await fireEvent.scroll(el);
		await tick();

		// Hard against the top: nowhere up to go, in either sense.
		expect(rail().start).toBeDisabled();
		expect(rail().prev).toBeDisabled();
		expect(rail().next).toBeEnabled();
		expect(rail().end).toBeEnabled();

		await fireEvent.click(rail().end);
		await tick();
		expect(el.scrollTop).toBe(2100); // the true bottom, not the last user turn's 2000.
		expect(rail().end).toBeDisabled();
		expect(rail().start).toBeEnabled();
		// Every user turn is now above the viewport top, so there is no pivot and
		// `prev` can only mean the last one; there is nothing after it.
		expect(rail().next).toBeDisabled();
		expect(rail().prev).toBeEnabled();

		await fireEvent.click(rail().prev);
		await tick();
		expect(el.scrollTop).toBe(2000);
		expect(rail().prev).toBeEnabled(); // the first turn is still above
		expect(rail().next).toBeDisabled();

		await fireEvent.click(rail().start);
		await tick();
		expect(el.scrollTop).toBe(0);
		expect(rail().start).toBeDisabled();
		expect(rail().prev).toBeDisabled();
	});

	it("disables next at the bottom even when later user turns are still below the viewport top", async () => {
		// Two user turns inside the last screenful. The scroller cannot bring
		// either to its top edge, so `next` would clamp straight back to where it
		// already is -- a live control that moves nothing.
		const messages = [user("first"), assistant([{ type: "text", text: "a" }], "stop"), user("second"), user("third")];
		const sessions = {
			"pi:pi-1": { ref: piSession, messages, isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		mockScrollMetrics(el, { scrollHeight: 2600, clientHeight: 500 });
		placeUserTurns(el, [0, 2300, 2400]); // both past the 2100 the scroller stops at
		el.scrollTop = 2100;
		await fireEvent.scroll(el);
		await tick();

		// The pivot here is the turn at 2300 and there *is* one after it, so the
		// "no later user turn" half of the rule does not cover this case.
		expect(screen.getByRole("button", { name: "Next user message" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Jump to end" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Previous user message" })).toBeEnabled();
	});

	it("treats a rail jump as a manual reading action: it disengages follow and never re-arms it", async () => {
		const messages = [user("first")];
		const sessions = {
			"pi:pi-1": { ref: piSession, messages, isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 500 });
		placeUserTurns(el, [0]);
		el.scrollTop = 100;
		await fireEvent.scroll(el);
		await tick();

		await fireEvent.click(screen.getByRole("button", { name: "Jump to end" }));
		expect(el.scrollTop).toBe(500); // scrollHeight(1000) - clientHeight(500): the true bottom, once.

		// More content arrives, streaming. Landing on the bottom is not follow
		// mode: only a submit arms that, and there has not been one.
		const grown = { ...sessions["pi:pi-1"], messages: [...messages, user("second")], isStreaming: true };
		mockScrollMetrics(el, { scrollHeight: 1400, clientHeight: 500 });
		controller.publish(view({ state: state({ selected: piSession, sessions: { "pi:pi-1": grown } }) }));
		await tick();
		// Park the new turn far below any cap, and force the next reconcile: were
		// follow armed on it, this would now track the tail at
		// scrollHeight(1400) - clientHeight(500). Without this the assertion below
		// holds for the wrong reason -- an unmocked rect reads 0, which happens to
		// reconcile back to the position the jump already left behind.
		mockContentTop(el.querySelector('[data-index="1"]') as HTMLElement, el, 5000);
		mockScrollMetrics(el, { scrollHeight: 1400, clientHeight: 500 });
		controller.publish(view({ state: state({ selected: piSession, sessions: { "pi:pi-1": grown } }) }));
		await tick();
		await nextFrame();
		expect(el.scrollTop).toBe(500); // unchanged -- it did not track the growth.
	});

	it("submits the prompt through its form and disables an empty prompt", async () => {
		const controller = new FakeController(view({ draft: "Summarize the diff" }));
		render(App, { props: { controller } });

		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		expect(controller.submitted).toBe(1);

		controller.publish(view({ draft: "" }));
		await tick();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("submits on Ctrl-Enter and Cmd-Enter but inserts a newline on plain Enter", async () => {
		const controller = new FakeController(view({ draft: "Summarize the diff" }));
		render(App, { props: { controller } });
		const textarea = screen.getByLabelText("Prompt");

		await fireEvent.keyDown(textarea, { key: "Enter" });
		expect(controller.submitted).toBe(0);

		await fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
		expect(controller.submitted).toBe(1);

		await fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
		expect(controller.submitted).toBe(2);
	});

	it("preserves the typed draft when form submission fails", async () => {
		const controller = new FakeController(view(), "Backend unavailable");
		render(App, { props: { controller } });

		await fireEvent.input(screen.getByLabelText("Prompt"), {
			target: { value: "Retry this prompt" },
		});
		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);

		expect(screen.getByLabelText("Prompt")).toHaveValue("Retry this prompt");
		expect(screen.getByRole("alert")).toHaveTextContent("Backend unavailable");
	});

	it("dismisses an error and does not leave it re-shown", async () => {
		const controller = new FakeController(view({ error: "Backend unavailable" }));
		render(App, { props: { controller } });

		expect(screen.getByRole("alert")).toHaveTextContent("Backend unavailable");
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(controller.clearErrorCalls).toBe(1);

		controller.publish(view({ error: null }));
		await tick();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows Stop only while the selected session is streaming", async () => {
		const controller = new FakeController(view({
			state: state({
				selected: piSession,
				sessions: {
					"pi:pi-1": {
						ref: piSession,
						messages: [],
						isStreaming: true,
						seq: 1,
						error: null,
						requests: [],
					},
				},
			}),
		}));
		render(App, { props: { controller } });

		await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(controller.aborted).toBe(1);

		controller.publish(view());
		await tick();
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
	});

	// -- compaction feedback (OW-natiha) ------------------------------------

	/** A selected, attached session whose backend is at `compaction` of a compaction. */
	function compactingState(compaction: "requesting" | "running" | null, isStreaming = false) {
		return state({
			selected: piSession,
			summaries: [summary(piSession, "P")],
			sessions: {
				"pi:pi-1": {
					ref: piSession,
					messages: [user("earlier")],
					isStreaming,
					compaction,
					seq: 1,
					error: null,
					requests: [],
				},
			},
		});
	}

	it("keeps the compaction acknowledgment in the action row until the terminal update (OW-natiha)", async () => {
		const controller = new FakeController(view({ busy: "compacting", state: compactingState("requesting") }));
		const { container } = render(App, { props: { controller } });

		const status = () => container.querySelector(".prompt-actions [role='status']");
		expect(status()).toHaveTextContent("Compaction requested…");

		// The request has resolved -- busy is idle again -- but the backend is
		// still working: the acknowledgment survives request admission.
		controller.publish(view({ busy: "idle", state: compactingState("running") }));
		await tick();
		expect(status()).toHaveTextContent("Compacting context…");

		// The terminal update, driven by the marker or the error, clears it.
		controller.publish(view({ busy: "idle", state: compactingState(null) }));
		await tick();
		expect(status()).toBeNull();
	});

	it("blocks Compact, Send, and the fork path while a compaction is in flight (OW-natiha)", async () => {
		const controller = new FakeController(view({ draft: "queued up", busy: "idle", state: compactingState("running") }));
		render(App, { props: { controller } });

		expect(screen.getByRole("menuitem", { name: "Compact", hidden: true })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

		// The keyboard path must not start work either.
		const prompt = screen.getByLabelText("Prompt");
		await fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
		expect(controller.submitted).toBe(0);

		// Nor the fork path: enter edit mode, then try the same shortcut.
		await fireEvent.click(screen.getByRole("button", { name: "Edit last message" }));
		await fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter", ctrlKey: true });
		expect(controller.forked).toEqual([]);
		expect(controller.submitted).toBe(0);
	});

	it("gives compaction precedence over isStreaming: no Stop control while it runs (OW-natiha)", async () => {
		// Codex and Claude keep `isStreaming` true on the wire through a
		// compaction, but that turn is not user-stoppable.
		const controller = new FakeController(view({ busy: "idle", state: compactingState("running", true) }));
		render(App, { props: { controller } });

		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

		// The edit shortcut neither reads as nor acts as a stop control.
		expect(screen.queryByRole("button", { name: "Stop and edit" })).not.toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Edit last message" }));
		expect(controller.aborted).toBe(0);

		// Once the compaction ends, the wire's streaming truth shows again.
		controller.publish(view({ busy: "idle", state: compactingState(null, true) }));
		await tick();
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
	});

	// -- edit and fork (OW-hezidi) ------------------------------------------

	/**
	 * A session holding `messages`, selected and attached, as the composer's
	 * edit path needs one.
	 */
	function attachedState(messages: AgentMessage[], ref: SessionRef = piSession, isStreaming = false) {
		return state({
			selected: ref,
			summaries: [summary(ref, "P")],
			sessions: {
				[sessionKey(ref)]: { ref, messages, isStreaming, seq: 1, error: null, requests: [] },
			},
		});
	}

	const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	it("filling the composer from an earlier user message asks the server for nothing, and marks it (OW-hezidi)", async () => {
		const controller = new FakeController(view({
			state: attachedState([user("first draft"), assistant([{ type: "text", text: "an answer" }]), user("second draft")]),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();

		const edits = screen.getAllByRole("button", { name: "Edit message" });
		expect(edits).toHaveLength(2); // one per user message, none on the assistant turn
		await fireEvent.click(edits[0]!);

		// Free and abandonable: the click is not a request, and nothing has been sent.
		expect(controller.forked).toEqual([]);
		expect(controller.submitted).toBe(0);
		expect(controller.selected).toEqual([]);
		expect(screen.getByLabelText("Prompt")).toHaveValue("first draft");

		const marked = container.querySelectorAll(".msg.editing");
		expect(marked).toHaveLength(1);
		expect(marked[0]).toHaveAttribute("data-index", "0");
		// Everything after it dims -- readable, but visibly not where this will land.
		expect([...container.querySelectorAll(".msg.dimmed")].map((el) => el.getAttribute("data-index")))
			.toEqual(["1", "2"]);
	});

	it("names the consequence on the primary button, and follows a turn ending mid-compose (OW-hezidi)", async () => {
		const messages = [user("first draft"), assistant([{ type: "text", text: "an answer" }])];
		const controller = new FakeController(view({ state: attachedState(messages) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const primary = () => container.querySelector("button[type='submit']")!;

		expect(primary()).toHaveTextContent("Send");

		await fireEvent.click(screen.getAllByRole("button", { name: "Edit message" })[0]!);
		expect(primary()).toHaveTextContent("Fork");

		// Scrolled up and hit edit while a turn was running: submitting stops it first.
		controller.publish(view({ draft: "first draft", state: attachedState(messages, piSession, true) }));
		await tick();
		expect(primary()).toHaveTextContent("Stop and fork");
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

		// That turn finishes while the edit is still being typed: the label reverts.
		controller.publish(view({ draft: "first draft", state: attachedState(messages, piSession, false) }));
		await tick();
		expect(primary()).toHaveTextContent("Fork");
	});

	it("carries an edited message's images into the fork rather than silently dropping them (OW-hezidi)", async () => {
		const withImages: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "What is in these?" },
				{ type: "image", mimeType: "image/png", data: PIXEL },
				{ type: "image", mimeType: "image/jpeg", data: PIXEL },
			],
			timestamp: 1786419855000,
		};
		const controller = new FakeController(view({
			state: attachedState([withImages, assistant([{ type: "text", text: "an answer" }])]),
		}));
		render(App, { props: { controller } });
		await tick();

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);

		expect(controller.forked).toEqual([{
			ordinal: 0,
			images: [
				{ mimeType: "image/png", base64: PIXEL },
				{ mimeType: "image/jpeg", base64: PIXEL },
			],
		}]);
	});

	it("cancels an edit on a click, restoring the displaced draft and the transcript (OW-hezidi)", async () => {
		const controller = new FakeController(view({
			draft: "half-written note",
			state: attachedState([user("first draft"), assistant([{ type: "text", text: "an answer" }])]),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		expect(screen.getByLabelText("Prompt")).toHaveValue("first draft");
		expect(container.querySelectorAll(".msg.editing")).toHaveLength(1);
		expect(container.querySelectorAll(".msg.dimmed")).toHaveLength(1);

		// A click, never a key: D14 -- an edit only a keyboard can abandon traps a
		// pointer user in a mode this design leans on leaving cheaply.
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.getByLabelText("Prompt")).toHaveValue("half-written note");
		expect(container.querySelectorAll(".msg.editing")).toHaveLength(0);
		expect(container.querySelectorAll(".msg.dimmed")).toHaveLength(0);
		expect(controller.forked).toEqual([]);
	});

	it("also cancels an edit on Escape, a second way out and never the only one (OW-hezidi)", async () => {
		const controller = new FakeController(view({
			draft: "half-written note",
			state: attachedState([user("first draft"), assistant([{ type: "text", text: "an answer" }])]),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		await fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Escape" });

		expect(screen.getByLabelText("Prompt")).toHaveValue("half-written note");
		expect(container.querySelectorAll(".msg.editing")).toHaveLength(0);
	});

	it("a Pi-shaped fork ends on the renamed ref with the follow and scroll maps re-keyed (OW-hezidi)", async () => {
		const forkRef: SessionRef = { backend: "pi", id: "pi-77" };
		const controller = new FakeController(view({
			state: attachedState([user("first draft"), assistant([{ type: "text", text: "an answer" }])]),
		}));
		// Pi's fork moves the live process onto a new file, and the server reports
		// that as `renamed` -- which lands while the fork request is still in flight.
		controller.onForkAndSubmit = () => controller.fireRename(piSession, forkRef);
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		expect(controller.forked).toEqual([{ ordinal: 0, images: [] }]);

		// The fork's own transcript arrives under the new key: everything before the
		// edited message, then the edited message itself.
		const reworded = user("reworded");
		mockScrollMetrics(el, { scrollHeight: 560, clientHeight: 500 });
		controller.publish(view({ draft: "", state: attachedState([reworded], forkRef) }));
		await tick();
		const anchorEl = el.querySelector('[data-index="0"]') as HTMLElement;
		mockContentTop(anchorEl, el, 5000);

		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({ draft: "", state: attachedState([reworded], forkRef, true) }));
		await tick();
		await nextFrame();

		// Keyed under "pi:pi-1" still, this reads 0 -- the fork's turn would stream
		// off the bottom of a transcript nothing was following.
		expect(el.scrollTop).toBe(400); // scrollHeight(900) - clientHeight(500)
		// And the edit mode is over: the original session reads normal afterwards.
		expect(container.querySelectorAll(".msg.editing")).toHaveLength(0);
		expect(container.querySelector("button[type='submit']")).toHaveTextContent("Send");
	});

	/**
	 * The Pi test above proves the `renamed` path. This one is the other half, and
	 * the only thing that covers `send()`'s own re-key: Codex renames nothing, so
	 * the follow armed under the parent's key before the fork has to be moved once
	 * `forkAndSubmit` resolves, or it is stranded there -- follow never engages on
	 * the fork, and the parent keeps a stale entry pointing at an earlier index.
	 */
	it("a Codex-shaped fork, which renames nothing, still ends following the fork's own turn (OW-hezidi)", async () => {
		const forkRef: SessionRef = { backend: "codex", id: "thread-2" };
		const controller = new FakeController(view({
			state: attachedState([user("first draft"), assistant([{ type: "text", text: "an answer" }])]),
		}));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;
		const reworded = user("reworded");
		// What the real `forkAndSubmit` does: it attaches the ref the fork returned
		// and publishes that selection *before* it resolves. No `renamed` ever fires.
		controller.onForkAndSubmit = () => {
			mockScrollMetrics(el, { scrollHeight: 560, clientHeight: 500 });
			controller.publish(view({ draft: "", state: attachedState([reworded], forkRef) }));
		};

		await fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		expect(controller.forked).toEqual([{ ordinal: 0, images: [] }]);
		expect(controller.getView().state.selected).toEqual(forkRef);

		const anchorEl = el.querySelector('[data-index="0"]') as HTMLElement;
		mockContentTop(anchorEl, el, 5000);

		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({ draft: "", state: attachedState([reworded], forkRef, true) }));
		await tick();
		await nextFrame();

		// Stranded under "pi:pi-1" this reads 60 -- where the session switch parked
		// it -- because nothing ever armed follow on the fork.
		expect(el.scrollTop).toBe(400); // scrollHeight(900) - clientHeight(500)
	});

	// -- composer shortcuts to the last message (OW-relehi) ------------------

	/**
	 * Everything an edit is observable as, from outside: what the composer holds,
	 * which message carries the mark, what dimmed behind it, and what the primary
	 * button says it will do. Both shortcuts below are the transcript's own edit
	 * gesture reached from elsewhere, so this is the shape the two get compared on.
	 */
	function editSnapshot(container: HTMLElement) {
		return {
			draft: (within(container).getByLabelText("Prompt") as HTMLTextAreaElement).value,
			marked: [...container.querySelectorAll(".msg.editing")].map((el) => el.getAttribute("data-index")),
			dimmed: [...container.querySelectorAll(".msg.dimmed")].map((el) => el.getAttribute("data-index")),
			primary: container.querySelector("button[type='submit']")!.textContent,
		};
	}

	it("stops the running turn and takes the last message back into the composer (OW-relehi)", async () => {
		const messages = [user("first draft"), assistant([{ type: "text", text: "an answer" }])];
		const controller = new FakeController(view({ state: attachedState(messages, piSession, true) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const primary = () => container.querySelector("button[type='submit']")!;

		await fireEvent.click(screen.getByRole("button", { name: "Stop and edit" }));

		// It stops at the click, not at submit: that is what the name promises, and
		// it is the one exception to OW-hezidi's rule that reaching for an edit is free.
		expect(controller.aborted).toBe(1);
		expect(screen.getByLabelText("Prompt")).toHaveValue("first draft");
		expect([...container.querySelectorAll(".msg.editing")].map((el) => el.getAttribute("data-index")))
			.toEqual(["0"]);
		// Still "Stop and fork" here, and that is the truth rather than a stale label:
		// `controller.abort()` does not clear `isStreaming` -- only a server event
		// does -- and `forkAndSubmit` re-checks it and aborts again before forking.
		expect(primary()).toHaveTextContent("Stop and fork");

		// The server reporting the turn stopped, which is the only thing that ever
		// clears `isStreaming`. Asserting "Fork" before this would assert a moment
		// the real app cannot promise.
		controller.publish(view({ draft: "first draft", state: attachedState(messages, piSession, false) }));
		await tick();
		expect(primary()).toHaveTextContent("Fork");
	});

	it("edits the last message into exactly the state the transcript's own edit control leaves (OW-relehi)", async () => {
		const messages = [
			user("first draft"),
			assistant([{ type: "text", text: "an answer" }]),
			user("second draft"),
			assistant([{ type: "text", text: "another answer" }]),
		];

		// Path one: scroll back and hit edit on the last user message.
		const long = new FakeController(view({ state: attachedState(messages) }));
		const longWay = render(App, { props: { controller: long } });
		await tick();
		const edits = within(longWay.container).getAllByRole("button", { name: "Edit message" });
		await fireEvent.click(edits[edits.length - 1]!);
		const viaTranscript = editSnapshot(longWay.container);
		longWay.unmount();

		// Path two: the composer's shortcut to the same message.
		const short = new FakeController(view({ state: attachedState(messages) }));
		const shortWay = render(App, { props: { controller: short } });
		await tick();
		await fireEvent.click(within(shortWay.container).getByRole("button", { name: "Edit last message" }));
		const viaShortcut = editSnapshot(shortWay.container);

		// Pinned, so the comparison cannot pass by both paths doing nothing.
		expect(viaTranscript).toEqual({
			draft: "second draft",
			marked: ["2"],
			dimmed: ["3"],
			primary: "Fork",
		});
		expect(viaShortcut).toEqual(viaTranscript);
		// The same operation, not a second implementation of it: neither path asks
		// the server for anything, and idle there is nothing to stop.
		expect(short.aborted).toBe(0);
		expect(short.forked).toEqual([]);
		expect(short.submitted).toBe(0);
	});

	it("offers neither shortcut without a user message to go back to (OW-relehi)", async () => {
		const shortcut = () => [
			...screen.queryAllByRole("button", { name: "Edit last message" }),
			...screen.queryAllByRole("button", { name: "Stop and edit" }),
		];

		// Nothing selected: the composer is there, and the shortcuts are not.
		const empty = new FakeController(view());
		const { unmount } = render(App, { props: { controller: empty } });
		await tick();
		expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
		expect(shortcut()).toEqual([]);
		unmount();

		// Selected, streaming, but the transcript holds no user message yet.
		const assistantOnly = new FakeController(view({
			state: attachedState([assistant([{ type: "text", text: "an answer" }])], piSession, true),
		}));
		render(App, { props: { controller: assistantOnly } });
		await tick();
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
		expect(shortcut()).toEqual([]);
	});

	it("reports reconnection and unsupported pending agent requests", () => {
		const controller = new FakeController(view({
			connection: "reconnecting",
			state: state({
				selected: piSession,
				sessions: {
					"pi:pi-1": {
						ref: piSession,
						messages: [],
						isStreaming: false,
						seq: 1,
						error: null,
						requests: [{ requestId: "request-1", session: piSession, kind: "approval", payload: {} }],
					},
				},
			}),
		}));
		render(App, { props: { controller } });

		expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
		expect(screen.getByText("Unsupported agent request pending.")).toBeInTheDocument();
	});

	it("warns by the composer when the draft starts with / but does not submit anything (OW-73)", async () => {
		const controller = new FakeController(view({ draft: "/compact" }));
		render(App, { props: { controller } });

		expect(screen.getByText(/does not run slash commands/i)).toBeInTheDocument();
		expect(controller.submitted).toBe(0);
	});

	it("still submits a slash-prefixed draft, unchanged, when sent (OW-73)", async () => {
		const controller = new FakeController(view({ draft: "/compact" }));
		render(App, { props: { controller } });

		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);

		expect(controller.submitted).toBe(1);
		expect(screen.getByLabelText("Prompt")).toHaveValue("/compact");
	});

	it("shows no slash-command warning for an ordinary draft (OW-73)", async () => {
		const controller = new FakeController(view({ draft: "Summarize the diff" }));
		render(App, { props: { controller } });

		expect(screen.queryByText(/does not run slash commands/i)).not.toBeInTheDocument();
	});

	/**
	 * Forwarding is all this side owns (OW-76): the controller holds the timer and
	 * decides whether there is anything to re-read, so the assertion here is the
	 * wiring itself -- unconditional, on both events, and torn down on unmount.
	 */
	it("asks the controller to re-read the preview when the tab comes back", async () => {
		const controller = new FakeController(view({ preview: { ref: piSession, turns: [previewUser("hi")] } }));
		const { unmount } = render(App, { props: { controller } });
		await tick();
		expect(controller.previewRefreshes).toBe(0);

		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
		await tick();
		expect(controller.previewRefreshes).toBe(2);

		unmount();
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
		expect(controller.previewRefreshes).toBe(2);
	});
});
