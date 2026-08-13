import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import type { BackendId, SessionRef, SessionSummary } from "$shared/protocol.ts";
import App from "./App.svelte";
import type { AgentpaneController, ControllerView } from "./controller.ts";
import { initialClientState, type ClientState } from "./session-state.ts";
import { assistant, user } from "./render/samples.ts";

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
		...overrides,
	};
}

class FakeController implements AgentpaneController {
	created: Array<{ cwd: string; backend: BackendId }> = [];
	selected: SessionRef[] = [];
	submitted = 0;
	aborted = 0;
	clearErrorCalls = 0;
	workspaces: string[] = [];
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

	async setWorkspace(cwd: string) {
		this.workspaces.push(cwd);
	}

	async create(cwd: string, backend: BackendId) {
		this.created.push({ cwd, backend });
	}

	async select(ref: SessionRef) {
		this.selected.push(ref);
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

	it("creates a session using the selected workspace and backend", async () => {
		const controller = new FakeController();
		render(App, { props: { controller } });

		await fireEvent.input(screen.getByLabelText("Workspace"), {
			target: { value: "/work/project" },
		});
		await fireEvent.change(screen.getByLabelText("Backend"), { target: { value: "codex" } });
		await fireEvent.click(screen.getByRole("button", { name: "New session" }));

		expect(controller.created).toEqual([{ cwd: "/work/project", backend: "codex" }]);
	});

	it("selects a session from its preview and falls back to its backend and id", async () => {
		const controller = new FakeController(view({
			state: state({ summaries: [summary(piSession, "Review the patch"), summary(codexSession)] }),
		}));
		render(App, { props: { controller } });

		await fireEvent.click(screen.getByRole("button", { name: "Review the patch" }));

		expect(controller.selected).toEqual([piSession]);
		expect(screen.getByRole("button", { name: "codex codex-1" })).toBeInTheDocument();
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
		expect(nav.getByText("/work/project")).toBeInTheDocument();
		expect(nav.getByText("2026-06-01 12:34:56")).toBeInTheDocument();
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

		// Session B has no scroll memory yet -- it lands at its own tail.
		mockScrollMetrics(el, { scrollHeight: 700, clientHeight: 500 });
		controller.publish(view({ state: state({ selected: codexSession, sessions }) }));
		await tick();
		expect(el.scrollTop).toBe(700);

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

	it("shows a jump-to-latest affordance whenever scrolled up, streaming or not, and it snaps once without re-arming follow", async () => {
		const messages = [user("first")];
		const sessions = {
			"pi:pi-1": { ref: piSession, messages, isStreaming: false, seq: 1, error: null, requests: [] },
		};
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();

		mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 500 });
		el.scrollTop = 100;
		await fireEvent.scroll(el);
		await tick();
		expect(screen.getByRole("button", { name: /jump to latest/i })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: /jump to latest/i }));
		expect(el.scrollTop).toBe(500); // scrollHeight(1000) - clientHeight(500): the true bottom, once.
		await tick();
		expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();

		// More content arrives; jump-to-latest does not re-arm following -- it only ever snapped once.
		mockScrollMetrics(el, { scrollHeight: 1400, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...sessions["pi:pi-1"], messages: [...messages, user("second")] } },
			}),
		}));
		await tick();
		expect(el.scrollTop).toBe(500); // unchanged: no submit happened, so follow never engaged.
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

	it("shows Abort only while the selected session is streaming", async () => {
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

		await fireEvent.click(screen.getByRole("button", { name: "Abort" }));
		expect(controller.aborted).toBe(1);

		controller.publish(view());
		await tick();
		expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
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
});
