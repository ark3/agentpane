import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import type { BackendId, SessionRef, SessionSummary } from "$shared/protocol.ts";
import App from "./App.svelte";
import type { AgentpaneController, ControllerView } from "./controller.ts";
import { initialClientState, type ClientState } from "./session-state.ts";
import { user } from "./render/samples.ts";

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

	it("shows each session's backend, a distinguishing id, its workspace, and a second-precision timestamp", () => {
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
		expect(nav.getByText("pi-1")).toBeInTheDocument();
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

	it("keeps following new content while at the bottom, and stops once the reader scrolls away", async () => {
		const base = { ref: piSession, messages: [user("first")], isStreaming: true, seq: 1, error: null, requests: [] };
		const controller = new FakeController(view({ state: state({ selected: piSession, sessions: { "pi:pi-1": base } }) }));
		const { container } = render(App, { props: { controller } });
		await tick();
		const el = container.querySelector(".conversation") as HTMLElement;

		// At the bottom already; new content pulls the view down with it.
		mockScrollMetrics(el, { scrollHeight: 600, clientHeight: 500 });
		el.scrollTop = 600;
		mockScrollMetrics(el, { scrollHeight: 900, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...base, messages: [...base.messages, user("second")] } },
			}),
		}));
		await tick();
		expect(el.scrollTop).toBe(900);

		// The reader scrolls up to read history.
		el.scrollTop = 100;
		await fireEvent.scroll(el);

		// More content arrives; the scrolled-up reader must not be yanked to the tail.
		mockScrollMetrics(el, { scrollHeight: 1200, clientHeight: 500 });
		controller.publish(view({
			state: state({
				selected: piSession,
				sessions: { "pi:pi-1": { ...base, messages: [...base.messages, user("second"), user("third")] } },
			}),
		}));
		await tick();
		expect(el.scrollTop).toBe(100);
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
