import { fireEvent, render, screen } from "@testing-library/svelte";
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

function summary(ref: SessionRef, preview: string | null = null): SessionSummary {
	return {
		ref,
		cwd: "/work/project",
		preview,
		createdAt: null,
		updatedAt: null,
		status: "attached",
		isStreaming: false,
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
	workspaces: string[] = [];
	started = 0;
	disposed = 0;
	private listeners = new Set<(next: ControllerView) => void>();

	constructor(private current: ControllerView = view()) {}

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
	}

	async abort() {
		this.aborted += 1;
	}

	publish(next: ControllerView) {
		this.current = next;
		for (const listener of this.listeners) listener(next);
	}
}

describe("App", () => {
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

	it("submits the prompt through its form and disables an empty prompt", async () => {
		const controller = new FakeController(view({ draft: "Summarize the diff" }));
		render(App, { props: { controller } });

		await fireEvent.submit(screen.getByLabelText("Prompt").closest("form")!);
		expect(controller.submitted).toBe(1);

		controller.publish(view({ draft: "" }));
		await tick();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("preserves the draft when the controller reports a submission failure", async () => {
		const controller = new FakeController(view({ draft: "Retry this prompt" }));
		render(App, { props: { controller } });

		controller.publish(view({ draft: "Retry this prompt", error: "Backend unavailable" }));
		await tick();

		expect(screen.getByLabelText("Prompt")).toHaveValue("Retry this prompt");
		expect(screen.getByRole("alert")).toHaveTextContent("Backend unavailable");
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
