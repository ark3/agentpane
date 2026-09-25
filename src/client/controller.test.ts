import { describe, expect, it, vi } from "vitest";
import type {
	AgentRequestReply,
	BackendId,
	ForkPoint,
	ForkRequest,
	LiveSessionSummary,
	ModelInfo,
	ServerEvent,
	SessionPreviewResponse,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
import type { AgentpaneApi, EventConnection, EventHandlers } from "./api.ts";
import { createController, type AgentpaneController } from "./controller.ts";
import { sessionKey } from "$shared/protocol.ts";

const ref: SessionRef = { backend: "pi", id: "virtual-a" };
const attachedRef: SessionRef = { backend: "pi", id: "/sessions/a.jsonl" };
/** A Codex-shaped fork: a brand-new thread this client is not driving yet. */
const forkedRef: SessionRef = { backend: "codex", id: "thread-forked" };

/** The handle the server minted for the session a ref names, opaque here (D24). */
function h(session: SessionRef): string {
	return `handle-${session.backend}-${session.id}`;
}

function summary(session: SessionRef, cwd = "/work", handle = h(session)): LiveSessionSummary {
	return {
		ref: session,
		cwd,
		preview: null,
		createdAt: null,
		updatedAt: null,
		status: "attached",
		isStreaming: false,
		onDisk: true,
		handle,
	};
}

function previewAssistant(text: string): SessionPreviewTurn {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "codex",
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

/**
 * The live view carrying `session` as its ref, found by ref and not by key so
 * that the rename tests below read the same whichever key the client uses.
 */
function viewAt(controller: AgentpaneController, session: SessionRef) {
	return Object.values(controller.getView().state.sessions).find((view) => sessionKey(view.ref) === sessionKey(session));
}

/** Let every microtask and the timer-free tail of an in-flight refresh run out. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
	let resolve: (value: T) => void;
	let reject: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve: resolve!, reject: reject! };
}

class FakeApi implements AgentpaneApi {
	readonly createSession = vi.fn(async (_body: { cwd: string; backend: BackendId }) => ref);
	readonly attach = vi.fn(async (session: SessionRef) => summary(session));
	readonly preview = vi.fn(
		async (session: SessionRef): Promise<SessionPreviewResponse> => ({ ref: session, turns: [] }),
	);
	readonly prompt = vi.fn(async (_session: SessionRef, _body: { text: string }) => {});
	readonly editDraft = vi.fn(async (_body: { text: string }) => ({ text: "edited draft" }));
	readonly abort = vi.fn(async (_session: SessionRef) => {});
	readonly compact = vi.fn(async (_session: SessionRef) => {});
	readonly close = vi.fn(async (_session: SessionRef) => {});
	readonly listModels = vi.fn(async (_backend: BackendId): Promise<ModelInfo[]> => []);
	readonly setModel = vi.fn(async (_session: SessionRef, _model: string) => {});
	readonly setEffort = vi.fn(async (_session: SessionRef, _effort: string) => {});
	readonly forkPoints = vi.fn(async (_session: SessionRef): Promise<ForkPoint[]> => []);
	readonly fork = vi.fn(async (_session: SessionRef, _body: ForkRequest) => forkedRef);
	readonly reply = vi.fn(async (_requestId: string, _body: AgentRequestReply) => {});
	readonly dismissError = vi.fn(async (_session: SessionRef, _message: string) => {});
	readonly listSessions = vi.fn(async (_cwd?: string): Promise<SessionSummary[]> => [summary(ref)]);
	readonly connection: EventConnection = { close: vi.fn() };
	handlers: EventHandlers | undefined;
	/** How many times the controller has built an event connection -- a reconnect is a second call. */
	connects = 0;

	connect(handlers: EventHandlers): EventConnection {
		this.handlers = handlers;
		this.connects += 1;
		return this.connection;
	}

	emit(event: ServerEvent): void {
		this.handlers?.onEvent(event);
	}

	/** The stream coming up. `connect` above does not fire this, so every open a test wants is explicit. */
	open(): void {
		this.handlers?.onOpen();
	}

	/** `fatal` is the source having reached `CLOSED`, where no `onopen` can ever follow (OW-dekuri). */
	drop(fatal = false): void {
		this.handlers?.onDisconnect(fatal);
	}
}

describe("client controller", () => {
	it("lists models when an attach response arrives before its empty snapshot", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();

		await controller.select(ref);
		expect(api.listModels).not.toHaveBeenCalled();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await Promise.resolve();

		expect(api.listModels).toHaveBeenCalledOnce();
		expect(api.listModels).toHaveBeenCalledWith("pi");
	});

	it("does not let an older A list overwrite a newer A list after A to B to A selection", async () => {
		const api = new FakeApi();
		const oldA = deferred<ModelInfo[]>();
		const newA = deferred<ModelInfo[]>();
		api.listModels.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(newA.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [{ role: "user", content: "done", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		const first = controller.preview(ref);
		await controller.preview(attachedRef);
		const third = controller.preview(ref);
		newA.resolve([{ id: "new", label: "New", efforts: [], defaultEffort: null }]);
		await third;
		oldA.resolve([{ id: "old", label: "Old", efforts: [], defaultEffort: null }]);
		await first;

		expect(controller.getView().models).toEqual([{ id: "new", label: "New", efforts: [], defaultEffort: null }]);
	});

	it("does not surface an obsolete A list failure after A to B to A selection", async () => {
		const api = new FakeApi();
		const oldA = deferred<ModelInfo[]>();
		const newA = deferred<ModelInfo[]>();
		api.listModels.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(newA.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [{ role: "user", content: "done", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		const first = controller.preview(ref);
		await controller.preview(attachedRef);
		const third = controller.preview(ref);
		newA.resolve([{ id: "new", label: "New", efforts: [], defaultEffort: null }]);
		await third;
		oldA.reject(new Error("obsolete list failure"));
		await first;

		expect(controller.getView().error).toBeNull();
		expect(controller.getView().models).toEqual([{ id: "new", label: "New", efforts: [], defaultEffort: null }]);
	});

	it("does not let A's pending set disable B or surface A's failure over B", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		api.setModel.mockReturnValue(setting.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);

		const selecting = controller.setModel("opaque/next");
		expect(controller.getView().modelSetting).toBe(true);
		await controller.preview(attachedRef);
		expect(controller.getView().modelSetting).toBe(false);
		setting.reject(new Error("A set failed"));
		await selecting;

		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().error).toBeNull();
	});

	it("keeps A's pending set authoritative across A to B to A selection", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		api.setModel.mockReturnValue(setting.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);

		const first = controller.setModel("opaque/next");
		await controller.preview(attachedRef);
		await controller.preview(ref);
		expect(controller.getView().modelSetting).toBe(true);

		const second = controller.setModel("opaque/later");
		expect(api.setModel).toHaveBeenCalledOnce();
		setting.reject(new Error("A set failed"));
		await Promise.all([first, second]);

		expect(controller.getView().error).toBe("A set failed");
		expect(controller.getView().modelSetting).toBe(false);
	});

	// The rename tests below stage the new ref on an ordinary event under the
	// session's handle, which is all a rename is on the wire (OW-mofuho) -- the
	// server sends a snapshot, but any event under the handle moves the ref --
	// and nothing in the controller tracks a rename (D24, OW-kimaya).
	it("carries a pending set through a virtual session rename", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		api.setModel.mockReturnValueOnce(setting.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);

		const first = controller.setModel("opaque/next");
		const renamed: SessionRef = { backend: "pi", id: "/sessions/real-a.jsonl" };
		api.emit({ type: "status", session: renamed, handle: h(ref), seq: 2, isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null });
		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().modelSetting).toBe(true);

		await controller.setModel("opaque/later");
		expect(api.setModel).toHaveBeenCalledOnce();
		setting.reject(new Error("renamed A set failed"));
		await first;

		expect(controller.getView().error).toBe("renamed A set failed");
		expect(controller.getView().modelSetting).toBe(false);
	});

	it("lists only for an empty selection and leaves model truth to server status", async () => {
		const api = new FakeApi();
		api.listModels.mockResolvedValue([{ id: "opaque/next", label: "Next", efforts: [], defaultEffort: null }]);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		await controller.preview(ref);
		expect(api.listModels).toHaveBeenCalledWith(ref.backend);
		await controller.setModel("opaque/next");
		expect(api.setModel).toHaveBeenCalledWith(ref, "opaque/next");
		expect(controller.getView().state.sessions[h(ref)]?.model).toBe("opaque/current");

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 2, isStreaming: false, compaction: null, model: "opaque/next", effort: null, unrestoredModel: null });
		expect(controller.getView().state.sessions[h(ref)]?.model).toBe("opaque/next");
	});

	it("never lists models when selecting a conversation that already has messages", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		await controller.preview(ref);

		expect(api.listModels).not.toHaveBeenCalled();
	});

	it("never sets a model once the conversation has a message", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);

		await controller.setModel("opaque/next");

		expect(api.setModel).not.toHaveBeenCalled();
		expect(controller.getView().modelSetting).toBe(false);
	});

	it("disables only model selection while setting and does not block the first prompt", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		api.setModel.mockReturnValue(setting.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);
		controller.setDraft("send while setting");

		const selecting = controller.setModel("opaque/next");
		expect(controller.getView()).toMatchObject({ busy: "idle", modelSetting: true });
		await controller.submit();
		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send while setting" });
		setting.resolve();
		await selecting;
	});

	it("sets an exact effort under its own pending flag, not the model's", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		api.setEffort.mockReturnValue(setting.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: "medium", unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);

		const choosing = controller.setEffort("high");
		expect(api.setEffort).toHaveBeenCalledWith(ref, "high");
		expect(controller.getView()).toMatchObject({ effortSetting: true, modelSetting: false });
		await controller.setEffort("low");
		expect(api.setEffort).toHaveBeenCalledOnce();
		setting.resolve();
		await choosing;

		expect(controller.getView().effortSetting).toBe(false);
		expect(controller.getView().state.sessions[h(ref)]?.effort).toBe("medium");
	});

	it("never sets an effort once the conversation has a message", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: "medium", unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);

		await controller.setEffort("high");

		expect(api.setEffort).not.toHaveBeenCalled();
		expect(controller.getView().effortSetting).toBe(false);
	});

	it("connects SSE and loads summaries when started", async () => {
		const api = new FakeApi();
		const controller = createController(api);

		await controller.start();

		expect(api.handlers).toBeDefined();
		expect(api.listSessions).toHaveBeenCalledWith(undefined);
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
	});

	it("creates, attaches, and selects the authoritative response ref without prompting", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);

		await controller.create("/work", "pi");

		expect(api.createSession).toHaveBeenCalledWith({ cwd: "/work", backend: "pi" });
		expect(api.attach).toHaveBeenCalledWith(ref);
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(api.prompt).not.toHaveBeenCalled();
	});

	it("selects the authoritative ref returned by attach", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);
		await controller.start();

		await controller.select(ref);

		expect(api.attach).toHaveBeenCalledWith(ref);
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().state.summaries).toEqual([summary(attachedRef)]);
	});

	it("previews a stored session read-only, selecting it without attaching or spawning", async () => {
		const api = new FakeApi();
		api.preview.mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
		const controller = createController(api);

		await controller.preview(ref);

		expect(api.preview).toHaveBeenCalledWith(ref);
		expect(api.attach).not.toHaveBeenCalled();
		expect(controller.getView().preview).toEqual({ ref, turns: [{ role: "user", content: "hi" }] });
		expect(controller.getView().state.selected).toEqual(ref);
	});

	it("reselects an already-attached session live instead of re-fetching a stale preview", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		// The snapshot a real attach produces gives this client live state for it.
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		expect(controller.getView().state.selected).toEqual(attachedRef);
		api.preview.mockClear();

		await controller.preview(attachedRef);

		expect(api.preview).not.toHaveBeenCalled();
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().preview).toBeNull();
	});

	it("clears the read-only preview once the session is attached", async () => {
		const api = new FakeApi();
		api.preview.mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);

		await controller.preview(ref);
		expect(controller.getView().preview).not.toBeNull();

		await controller.select(ref);

		expect(api.attach).toHaveBeenCalledWith(ref);
		expect(controller.getView().preview).toBeNull();
		expect(controller.getView().state.selected).toEqual(attachedRef);
	});

	it("keeps the latest selection when earlier and later attaches resolve out of order", async () => {
		const api = new FakeApi();
		const firstRef: SessionRef = { backend: "pi", id: "/sessions/first.jsonl" };
		const secondRef: SessionRef = { backend: "codex", id: "thread-second" };
		const first = deferred<LiveSessionSummary>();
		const second = deferred<LiveSessionSummary>();
		api.attach.mockImplementation((session) => {
			if (session.id === firstRef.id) return first.promise;
			if (session.id === secondRef.id) return second.promise;
			throw new Error(`unexpected ref ${session.id}`);
		});
		const controller = createController(api);

		const selectingFirst = controller.select(firstRef);
		const selectingSecond = controller.select(secondRef);
		second.resolve(summary(secondRef));
		await selectingSecond;
		expect(controller.getView().state.selected).toEqual(secondRef);

		first.resolve(summary(firstRef));
		await selectingFirst;

		expect(controller.getView().state.selected).toEqual(secondRef);
		expect(controller.getView().state.summaries).toEqual([summary(secondRef), summary(firstRef)]);
	});

	it("ignores a stale create response after a newer selection completes", async () => {
		const api = new FakeApi();
		const createdRef: SessionRef = { backend: "pi", id: "virtual-created" };
		const selectedRef: SessionRef = { backend: "codex", id: "thread-selected" };
		const created = deferred<SessionRef>();
		api.createSession.mockReturnValue(created.promise);
		const controller = createController(api);

		const creating = controller.create("/work", "pi");
		await controller.select(selectedRef);
		expect(controller.getView().state.selected).toEqual(selectedRef);
		expect(controller.getView().busy).toBe("idle");

		created.resolve(createdRef);
		await creating;

		expect(api.attach).toHaveBeenCalledTimes(1);
		expect(api.attach).toHaveBeenCalledWith(selectedRef);
		expect(controller.getView().state.selected).toEqual(selectedRef);
		expect(controller.getView().busy).toBe("idle");
	});

	it("keeps the draft when prompt submission fails", async () => {
		const api = new FakeApi();
		api.prompt.mockRejectedValue(new Error("offline"));
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("keep me");

		await controller.submit();

		expect(controller.getView().draft).toBe("keep me");
		expect(controller.getView().error).toBe("offline");
	});

	it("replaces the current draft with the external editor result", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		controller.setDraft("current draft");

		await controller.editDraft();

		expect(api.editDraft).toHaveBeenCalledWith({ text: "current draft" });
		expect(controller.getView()).toMatchObject({ draft: "edited draft", busy: "idle", error: null });
	});

	it("surfaces an external editor failure and gates re-entry while it is open", async () => {
		const api = new FakeApi();
		const editing = deferred<{ text: string }>();
		api.editDraft.mockReturnValue(editing.promise);
		const controller = createController(api);
		controller.setDraft("keep me");

		const first = controller.editDraft();
		const second = controller.editDraft();
		expect(controller.getView().busy).toBe("editing-externally");
		expect(api.editDraft).toHaveBeenCalledTimes(1);
		editing.reject(new Error("editor exited 1"));
		await Promise.all([first, second]);

		expect(controller.getView()).toMatchObject({ draft: "keep me", busy: "idle", error: "editor exited 1" });
	});

	it("clears the draft only after the prompt is accepted", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("send me");

		await controller.submit();

		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send me" });
		expect(controller.getView().draft).toBe("");
	});

	it("ignores a second submit while the first prompt is still in flight", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("send me once");

		const first = controller.submit();
		const second = controller.submit();

		expect(api.prompt).toHaveBeenCalledOnce();
		prompt.resolve();
		await Promise.all([first, second]);
		expect(controller.getView()).toMatchObject({ draft: "", busy: "idle" });
	});

	it("keeps the view error through a broadcast-driven re-list (OW-dinuwu)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.submit();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");

		api.emit({ type: "sessions-changed" });
		await settle();

		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");
		controller.dispose();
	});

	it("leaves busy at submitting across a broadcast-driven re-list (OW-dinuwu)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const submitted = controller.submit();

		api.emit({ type: "sessions-changed" });
		await settle();

		expect(controller.getView().busy).toBe("submitting");
		prompt.resolve();
		await submitted;
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// The server broadcasts `sessions-changed` at every turn boundary (OW-furinu),
	// so one lands inside every prompt's round trip -- and the re-list it triggers
	// used to clear `busy` under the guard above and let the second press through
	// (OW-dinuwu).
	it("ignores a second submit after the in-flight prompt's own re-list (OW-dinuwu)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const first = controller.submit();

		api.emit({ type: "sessions-changed" });
		await settle();
		const second = controller.submit();

		expect(api.prompt).toHaveBeenCalledOnce();
		prompt.resolve();
		await Promise.all([first, second]);
		controller.dispose();
	});

	it("surfaces a failure to a Refresh that joined a broadcast-driven re-list (OW-dinuwu)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		const listed = deferred<SessionSummary[]>();
		api.listSessions.mockReturnValueOnce(listed.promise);
		api.emit({ type: "sessions-changed" });

		// The press joins the silent listing rather than starting its own, so this
		// is the only thing that can report the failure to the user.
		const pressed = controller.refreshSessions();
		listed.reject(new Error("list is down"));
		await pressed;

		expect(controller.getView().error).toBe("list is down");
		controller.dispose();
	});

	it("keeps a draft typed while the prompt is in flight", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("send me");

		const submitted = controller.submit();
		controller.setDraft("the next thing I want to say");
		prompt.resolve();
		await submitted;

		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send me" });
		expect(controller.getView().draft).toBe("the next thing I want to say");
	});

	it("aborts the current authoritative selected ref", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);
		await controller.select(ref);

		await controller.abort();

		expect(api.abort).toHaveBeenCalledWith(attachedRef);
	});

	it("updates selection from the snapshot that introduces a session under a ref its attach reply did not name", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };

		api.emit({ type: "snapshot", session: renamed, handle: h(ref), seq: 2, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().state.summaries.map((item) => item.ref)).toContainEqual(renamed);
		expect(viewAt(controller, renamed)?.seq).toBe(2);
	});

	it("coalesces recovery attaches while a sequence-gap recovery is in flight", async () => {
		const api = new FakeApi();
		const recovery = deferred<LiveSessionSummary>();
		api.attach.mockImplementationOnce(async (session) => summary(session)).mockImplementationOnce(() => recovery.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });

		expect(api.attach).toHaveBeenCalledTimes(2);
		recovery.resolve(summary(ref));
		await recovery.promise;
	});

	it("keeps the view error through a sequence-gap recovery (OW-yasewo)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.submit();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(api.attach).toHaveBeenCalledWith(ref);
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");
		controller.dispose();
	});

	// `busy` is one global slot and `recover` is per-session, so a gap on B used
	// to write "Opening session…" over the prompt the user is watching in A.
	it("leaves busy at submitting across another session's recovery (OW-yasewo)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const submitted = controller.submit();

		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "status", session: attachedRef, handle: h(attachedRef), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(controller.getView().busy).toBe("submitting");
		prompt.resolve();
		await submitted;
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// A regression guard, not a red-first test: since OW-kelede the send guard
	// reads `sending`, which no recovery touches. Nothing else pins `recover`
	// against that guard, and the guard has moved once already.
	it("ignores a second submit while another session recovers (OW-yasewo)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const first = controller.submit();

		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "status", session: attachedRef, handle: h(attachedRef), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();
		const second = controller.submit();

		expect(api.prompt).toHaveBeenCalledOnce();
		prompt.resolve();
		await Promise.all([first, second]);
		controller.dispose();
	});

	it("does not select an unrelated session while recovering it", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await Promise.resolve();

		expect(controller.getView().state.selected).toBeNull();
	});

	it("coalesces concurrent session-list refreshes", async () => {
		const api = new FakeApi();
		const listed = deferred<SessionSummary[]>();
		const controller = createController(api);
		await controller.start();
		api.listSessions.mockClear();
		api.listSessions.mockImplementationOnce(() => listed.promise);

		api.emit({ type: "sessions-changed" });
		api.emit({ type: "sessions-changed" });

		expect(api.listSessions).toHaveBeenCalledTimes(1);
		listed.resolve([summary(attachedRef)]);
		await listed.promise;
		expect(controller.getView().state.summaries).toEqual([summary(attachedRef)]);
	});

	it("forgets a cached live session when a fresh listing reports it detached", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		const detached = { ...summary(ref), status: "detached" as const, isStreaming: false };
		api.listSessions.mockResolvedValueOnce([detached]);

		api.emit({ type: "sessions-changed" });
		await vi.waitFor(() => expect(controller.getView().state.summaries).toEqual([detached]));

		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.summaries[0]?.isStreaming).toBe(false);
		api.preview.mockClear();
		await controller.preview(ref);
		expect(api.preview).toHaveBeenCalledWith(ref);
	});

	// Both orderings, because the detach must not depend on the broadcast: the
	// re-list is what `replaceSessionSummaries` drops a live view from, and
	// `preview` short-circuits on a session this client still has attached, so
	// whichever wins the race the view has to be gone and the preview on screen.
	for (const relistFirst of [true, false]) {
		const when = relistFirst ? "before" : "after";
		it(`detaches the selected session onto its read-only preview, with the re-list landing ${when} the preview`, async () => {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			await controller.select(ref);
			api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
			const detachedSummary = { ...summary(ref), status: "detached" as const, isStreaming: false };
			api.listSessions.mockResolvedValue([detachedSummary]);
			const turns: SessionPreviewTurn[] = [{ role: "user", content: "done" }];
			const previewed = deferred<SessionPreviewResponse>();
			// The re-list refreshes whatever preview is on screen, so a second read
			// can follow the first; both answer with the same stored transcript.
			api.preview.mockResolvedValue({ ref, turns });
			api.preview.mockReturnValueOnce(previewed.promise);

			const detaching = controller.detach();
			await settle();

			expect(api.close).toHaveBeenCalledWith(ref);
			expect(api.preview).toHaveBeenCalledWith(ref);
			if (relistFirst) {
				api.emit({ type: "sessions-changed" });
				await settle();
			}
			previewed.resolve({ ref, turns });
			await detaching;
			if (!relistFirst) {
				api.emit({ type: "sessions-changed" });
				await settle();
			}

			const detachedView = controller.getView();
			expect(detachedView.state.sessions[h(ref)]).toBeUndefined();
			expect(detachedView.state.selected).toEqual(ref);
			expect(detachedView.preview).toEqual({ ref, turns });
			expect(detachedView.state.summaries).toEqual([detachedSummary]);
			controller.dispose();
		});
	}

	// The sidebar's attached stripe reads `summary.status`, and only a listing
	// moves that -- so a detach whose `sessions-changed` broadcast never arrives,
	// the SSE connection being down, left the row lit as attached until the user
	// pressed Refresh: the exact untruthful indicator Detach exists to clear
	// (OW-lejahi). The detach itself no longer asks for that listing; the
	// reconnect does (D21), so the stripe clears when the stream comes back and
	// no broadcast is needed anywhere in this test.
	it("clears a detached row's stripe at the reconnect when no broadcast followed the detach", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		const detachedSummary = { ...summary(ref), status: "detached" as const, isStreaming: false };
		api.listSessions.mockResolvedValue([detachedSummary]);

		api.drop();
		await controller.detach();
		await settle();
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);

		api.open();
		await settle();

		expect(controller.getView().state.summaries).toEqual([detachedSummary]);
		controller.dispose();
	});

	// Of the eight `SessionSummary` fields, `status` and `updatedAt` move only
	// when a listing moves them, and every `sessions-changed` that fanned out
	// while the stream was down is gone: there is no `Last-Event-ID` cursor and
	// no replay buffer, and the opening snapshots carry neither field
	// (OW-vukoku). So the re-established stream is the whole trigger here -- no
	// event is emitted at all.
	it("re-lists when the event stream comes back up", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await settle();
		const missed = { ...summary(ref), status: "detached" as const, updatedAt: "2026-09-16T04:00:00.000Z" };
		api.listSessions.mockResolvedValue([missed]);

		api.drop();
		api.open();
		await settle();

		expect(controller.getView().state.summaries).toEqual([missed]);
		controller.dispose();
	});

	// A fatally closed `EventSource` -- the server answered 404, or answered
	// with the wrong content type -- never fires `onopen` again, so D21's
	// re-list at the open cannot heal anything and the client would sit in
	// `reconnecting` until the user pressed Refresh (OW-dekuri). Nothing here
	// re-opens on its own: the only opens are the ones the rebuilt connections
	// earn, and the healed sidebar at the end is the whole claim.
	it("rebuilds a fatally closed event stream until one opens, and heals with no user gesture", async () => {
		vi.useFakeTimers();
		try {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			api.open();
			await vi.advanceTimersByTimeAsync(0);
			expect(api.connects).toBe(1);
			const missed = { ...summary(ref), status: "detached" as const, updatedAt: "2026-09-16T04:00:00.000Z" };
			api.listSessions.mockResolvedValue([missed]);

			api.drop(true);
			expect(controller.getView().connection).toBe("reconnecting");
			await vi.advanceTimersByTimeAsync(4_999);
			expect(api.connects).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(api.connects).toBe(2);
			expect(api.connection.close).toHaveBeenCalledOnce();

			// Still fatal: the retry keeps going rather than stopping at one try.
			api.drop(true);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(api.connects).toBe(3);

			api.open();
			await vi.advanceTimersByTimeAsync(0);
			expect(controller.getView().connection).toBe("connected");
			expect(controller.getView().state.summaries).toEqual([missed]);

			// A pending retry does not outlive the controller.
			api.drop(true);
			controller.dispose();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(api.connects).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	// An error at `readyState === CONNECTING` is the browser's own retry already
	// under way, and the `onopen` it earns is what D21 heals at. Rebuilding
	// there would race that retry and double the request rate against a server
	// that is merely restarting (OW-dekuri).
	it("leaves a recoverable drop to the browser's own retry", async () => {
		vi.useFakeTimers();
		try {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			api.open();
			await vi.advanceTimersByTimeAsync(0);

			api.drop();
			await vi.advanceTimersByTimeAsync(60_000);

			expect(api.connects).toBe(1);
			expect(api.connection.close).not.toHaveBeenCalled();
			controller.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	// The first open is `start()`'s own listing arriving by another door: the
	// native `EventSource` fires `onopen` on the initial connect as well as on
	// every re-establish, and `refreshInFlight` only coalesces listings that
	// overlap -- an open landing after the startup listing resolves would list a
	// second time (OW-vukoku).
	it("does not list a second time on the first open", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		// Load-bearing, not decoration: it drains `refreshInFlight`, so the open
		// below lands after the startup listing rather than inside it. Without it
		// an ungated `onOpen` would be coalesced and this would pass for the wrong
		// reason.
		await settle();
		expect(api.listSessions).toHaveBeenCalledOnce();

		api.open();
		await settle();

		expect(api.listSessions).toHaveBeenCalledOnce();
		controller.dispose();
	});

	// The gate is "a listing has already covered this open", and a startup
	// listing that failed covered nothing: `refreshSessions` swallows the
	// rejection and resolves, so counting opens alone would skip the re-list on
	// the one open where the sidebar is emptiest -- the page loaded, the server
	// was away for both the listing and the connect, and the first `onopen` of
	// all is the server coming back (OW-vukoku).
	it("lists on the first open when the startup listing failed", async () => {
		const api = new FakeApi();
		api.listSessions.mockRejectedValueOnce(new Error("offline"));
		const controller = createController(api);
		await controller.start();
		await settle();
		expect(controller.getView().state.summaries).toEqual([]);

		api.open();
		await settle();

		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		controller.dispose();
	});

	// Every backend replaces the `virtual:` id at attach and none writes before
	// the first turn (D9), so a session created here and detached before its
	// first prompt holds an ordinary-looking id with nothing behind it. Its
	// summary says so, and the id does not (OW-wedupe).
	const createdRef: SessionRef = { backend: "pi", id: "/sessions/created.jsonl" };

	function createRenamedAtAttach(api: FakeApi, onDisk: boolean): void {
		api.createSession.mockResolvedValue({ backend: "pi", id: "virtual:a" });
		api.attach.mockResolvedValue({ ...summary(createdRef), onDisk });
	}

	// A detached session with nothing on disk is gone everywhere -- no file, and
	// dropped from the manager's table -- but its row lives on in `summaries`,
	// which is what the sidebar renders, and clicking it lands on exactly the
	// screen OW-vasubu exists to prevent. So this exit asks for the listing
	// itself rather than waiting for the reconnect the stripe waits for (D21).
	// The stream is down here and no event is emitted.
	it("drops the phantom row of a detached session with nothing on disk, with no broadcast to ride on", async () => {
		const api = new FakeApi();
		createRenamedAtAttach(api, false);
		const controller = createController(api);
		await controller.start();
		await controller.create("/work", "pi");
		api.emit({ type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		expect(controller.getView().state.summaries.map((item) => sessionKey(item.ref))).toContain(sessionKey(createdRef));
		api.listSessions.mockResolvedValue([]);

		api.drop();
		await controller.detach();
		await settle();

		expect(controller.getView().state.summaries).toEqual([]);
		controller.dispose();
	});

	// Nothing on disk means `preview` would answer with an empty-but-non-null
	// transcript and strand the user on a screen whose only control is an
	// Attach the session manager can no longer honour (OW-vasubu).
	it("clears the selection onto the startup view when the session detached before its first turn was renamed at attach", async () => {
		const api = new FakeApi();
		createRenamedAtAttach(api, false);
		const controller = createController(api);
		await controller.start();
		await controller.create("/work", "pi");
		api.emit({ type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		expect(controller.getView().state.selected).toEqual(createdRef);

		await controller.detach();
		await settle();

		const detachedView = controller.getView();
		expect(api.close).toHaveBeenCalledWith(createdRef);
		expect(api.preview).not.toHaveBeenCalled();
		expect(detachedView.state.selected).toBeNull();
		expect(detachedView.preview).toBeNull();
		expect(detachedView.state.sessions[h(createdRef)]).toBeUndefined();
		// The re-list is on this exit, and only this one: the row it removes is
		// not merely stale, it points at a session that exists nowhere (D21).
		expect(api.listSessions).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	// A fork is born with no file on every backend, and gets one only when its
	// first turn ends (OW-japuzo, OW-hojefo). Detaching it mid-turn kills that
	// turn, so nothing is ever written.
	it("clears the selection onto the startup view when the detached fork has run no turn", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		api.attach.mockImplementation(async (session: SessionRef) =>
			sessionKey(session) === sessionKey(forkedRef) ? { ...summary(session), onDisk: false } : summary(session),
		);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");
		expect((await controller.forkAndSubmit(0))?.ref).toEqual(forkedRef);
		api.emit({ type: "snapshot", session: forkedRef, handle: h(forkedRef), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		expect(controller.getView().state.selected).toEqual(forkedRef);

		await controller.detach();
		await settle();

		const detachedView = controller.getView();
		expect(api.close).toHaveBeenCalledWith(forkedRef);
		expect(api.preview).not.toHaveBeenCalled();
		expect(detachedView.state.selected).toBeNull();
		expect(detachedView.preview).toBeNull();
		expect(api.listSessions).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	// The other side of the same signal: once a turn has written the store, the
	// listing that turn's end asks for says so, and the session detaches onto its
	// preview like any stored one (OW-tewave).
	it("previews a session created here once a listing has found its first turn on disk", async () => {
		const api = new FakeApi();
		createRenamedAtAttach(api, false);
		const controller = createController(api);
		await controller.start();
		await controller.create("/work", "pi");
		api.emit({ type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.listSessions.mockResolvedValue([{ ...summary(createdRef), onDisk: true }]);
		api.emit({ type: "sessions-changed" });
		await settle();

		await controller.detach();
		await settle();

		expect(api.preview).toHaveBeenCalledWith(createdRef);
		expect(controller.getView().state.selected).toEqual(createdRef);
		controller.dispose();
	});

	it("leaves the selection where a click landed it while the detach's close was still in flight", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		const closing = deferred<void>();
		api.close.mockReturnValueOnce(closing.promise);

		const detaching = controller.detach();
		await settle();
		await controller.preview(attachedRef);
		expect(controller.getView().state.selected).toEqual(attachedRef);

		closing.resolve();
		await detaching;

		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(api.preview).not.toHaveBeenCalledWith(ref);
		controller.dispose();
	});

	// A dropped SSE event lands as a sequence gap, and the reducer answers a gap
	// by asking for a re-attach -- which, inside a detach's window, would spawn
	// the subprocess the user just asked to be rid of (OW-sugome).
	it("does not re-attach a session whose detach is still in flight when its sequence gaps", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		const closing = deferred<void>();
		api.close.mockReturnValueOnce(closing.promise);

		const detaching = controller.detach();
		await settle();
		api.attach.mockClear();
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 7, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		closing.resolve();
		await detaching;
		await settle();

		expect(api.attach).not.toHaveBeenCalled();
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		controller.dispose();
	});

	it("does not forget or demote a session updated while a detached listing is in flight", async () => {
		const api = new FakeApi();
		const listed = deferred<SessionSummary[]>();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.listSessions.mockClear();
		api.listSessions.mockReturnValueOnce(listed.promise);

		api.emit({ type: "sessions-changed" });
		api.emit({ type: "sessions-changed" });
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 2, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		const detached = { ...summary(ref), status: "detached" as const, isStreaming: false };
		listed.resolve([detached]);
		await vi.waitFor(() => expect(controller.getView().state.summaries).toEqual([summary(ref)]));

		expect(api.listSessions).toHaveBeenCalledTimes(1);
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		expect(controller.getView().state.sessions[h(ref)]?.seq).toBe(2);
	});

	it("rejects a relative workspace before creating a session", async () => {
		const api = new FakeApi();
		const controller = createController(api);

		await controller.create("work/project", "pi");

		expect(api.createSession).not.toHaveBeenCalled();
		expect(controller.getView().error).toBe("Workspace must be an absolute path.");
	});

	it("clears a session's persisted turn error on the next successful submit", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error." });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");

		controller.setDraft("try again");
		await controller.submit();

		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
	});

	it("clears the persisted error of a session renamed while the prompt was in flight (D9)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "Stale error from a prior turn." });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// The session renames (virtual -> real) while the prompt is still in flight.
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };
		api.emit({ type: "status", session: renamed, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		prompt.resolve();
		await submitted;

		expect(viewAt(controller, renamed)?.error).toBeNull();
	});

	it("does not clear a fresh same-turn error that races in via SSE before the prompt POST resolves (D2)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// A genuine error for *this* turn arrives before the POST's own response does.
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "This turn just failed." });
		prompt.resolve();
		await submitted;

		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("This turn just failed.");
	});

	it("does not clear a model failure that lands before the prompt POST resolves", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		const prompt = deferred<void>();
		api.setModel.mockReturnValue(setting.promise);
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await controller.preview(ref);
		controller.setDraft("start while setting");

		const set = controller.setModel("opaque/next");
		const submitted = controller.submit();
		expect(api.prompt).toHaveBeenCalledOnce();
		setting.reject(new Error("Model selection failed"));
		await set;
		expect(controller.getView().error).toBe("Model selection failed");

		prompt.resolve();
		await submitted;
		expect(controller.getView().error).toBe("Model selection failed");
	});

	it("dismisses the view error and the selected session's persisted error", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error." });

		controller.clearError();

		expect(controller.getView().error).toBeNull();
		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
		// The server holds the error too, and would put it back on the next
		// snapshot if it were not told (OW-bipume).
		// It names the error it dismisses, so a newer one the server holds by
		// then is left standing.
		expect(api.dismissError).toHaveBeenCalledExactlyOnceWith(ref, "The turn ended in an error.");
	});

	it("tells the server nothing when the selected session holds no error to dismiss (OW-bipume)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		controller.clearError();

		expect(api.dismissError).not.toHaveBeenCalled();
	});

	it("reads as compacting for the whole of the compaction request (OW-81)", async () => {
		const api = new FakeApi();
		const compacting = deferred<void>();
		api.compact.mockReturnValue(compacting.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);

		const compacted = controller.compact();

		expect(api.compact).toHaveBeenCalledWith(ref);
		expect(controller.getView().busy).toBe("compacting");

		compacting.resolve();
		await compacted;

		expect(controller.getView().busy).toBe("idle");
	});

	/**
	 * OW-natiha. `api.compact()` resolving is *admission*, not completion: the
	 * backend's work is still running, and only its status/snapshot events end
	 * it. The controller marks the session "requesting" at the request itself --
	 * the server's own "requesting" status races the POST response (D2), and the
	 * click needs feedback either way -- and server events overwrite that mark.
	 */
	it("keeps the session reading as compacting after the request resolves, until a terminal event (OW-natiha)", async () => {
		const api = new FakeApi();
		const compacting = deferred<void>();
		api.compact.mockReturnValue(compacting.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		const compacted = controller.compact();
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("requesting");

		compacting.resolve();
		await compacted;

		// The request resolved with no backend lifecycle update yet: still compacting.
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("requesting");

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 2, isStreaming: false, compaction: "running", model: null, effort: null, unrestoredModel: null });
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("running");

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBeNull();
	});

	it("clears its own requesting mark when the compaction request fails (OW-natiha)", async () => {
		const api = new FakeApi();
		const compacting = deferred<void>();
		api.compact.mockReturnValue(compacting.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		const compacted = controller.compact();
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("requesting");

		compacting.reject(new Error("compaction refused"));
		await compacted;

		expect(controller.getView().error).toBe("compaction refused");
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBeNull();
	});

	it("clears the requesting mark on failure through a mid-flight rename (OW-natiha)", async () => {
		const api = new FakeApi();
		const compacting = deferred<void>();
		api.compact.mockReturnValue(compacting.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		const compacted = controller.compact();
		expect(viewAt(controller, ref)?.compaction).toBe("requesting");

		// The server renames the session while the POST is in flight (D9); the
		// status that carries the new ref carries the mark too.
		api.emit({ type: "status", session: attachedRef, handle: h(ref), seq: 2, isStreaming: false, compaction: "requesting", model: null, effort: null, unrestoredModel: null });

		compacting.reject(new Error("compaction refused"));
		await compacted;

		expect(controller.getView().error).toBe("compaction refused");
		expect(viewAt(controller, attachedRef)?.compaction).toBeNull();
	});

	/**
	 * OW-hezidi. The fork point is addressed by the *transcript index* it names,
	 * so identical wording in two messages cannot confuse it (OW-roveze).
	 */
	it("forks at the point naming that transcript index and only then prompts, into the ref the fork returned (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([
			{ id: "turn-1", text: "same words", index: 0 },
			{ id: "turn-2", text: "same words", index: 2 },
			{ id: "turn-3", text: "same words", index: 4 },
		]);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("reworded");

		await controller.forkAndSubmit(2);

		expect(api.forkPoints).toHaveBeenCalledWith(ref);
		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-2" });
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded" });
		// Order, not just occurrence: prompting the parent and then forking would
		// leave the edited turn on the session the edit was supposed to spare.
		expect(api.fork.mock.invocationCallOrder[0]!).toBeLessThan(api.prompt.mock.invocationCallOrder[0]!);
		expect(controller.getView().draft).toBe("");
	});

	/**
	 * OW-roveze, the defect this addressing scheme exists for. Steering a running
	 * Codex turn puts a second `userMessage` in it, which is its own `role:
	 * "user"` transcript message -- but Codex forks at turn granularity, so the
	 * turn still answers with one point. Three user messages, two points.
	 *
	 * Counting user messages made the click on the third one ask for the point at
	 * position 2, which is the *third* turn: a fork one whole turn past where the
	 * user pointed, with no error and nothing on screen to notice. Here the same
	 * click asks for transcript index 3 and gets the turn that holds it.
	 */
	it("forks at the turn holding the clicked message, not the turn in that position (OW-roveze)", async () => {
		const api = new FakeApi();
		// T1: prompt at 0, reply at 1, steered prompt at 2, reply at 3.
		// T2: prompt at 4, reply at 5. Two turns, three user messages.
		api.forkPoints.mockResolvedValue([
			{ id: "turn-1", text: "first", index: 0 },
			{ id: "turn-2", text: "second", index: 4 },
		]);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("reworded");

		expect((await controller.forkAndSubmit(4))?.ref).toEqual(forkedRef);

		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-2" });
	});

	/**
	 * The other half of OW-roveze: the steered message itself. No point names
	 * index 2, so there is nothing to fork at and the answer is a refusal --
	 * never the next point along, which is what a positional lookup would have
	 * handed back. The shell normally draws no Edit control on such a message at
	 * all; reaching here means the transcript moved under the affordance.
	 */
	it("refuses, rather than forking elsewhere, at a message steering added mid-turn (OW-roveze)", async () => {
		const api = new FakeApi();
		// Three turns, so a positional lookup finds *something* at every position
		// a click can produce -- which is the silent half of the defect: no error,
		// and a fork at a turn the user never pointed at.
		api.forkPoints.mockResolvedValue([
			{ id: "turn-1", text: "first", index: 0 },
			{ id: "turn-2", text: "second", index: 4 },
			{ id: "turn-3", text: "third", index: 6 },
		]);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("reworded");

		expect(await controller.forkAndSubmit(2)).toBeNull();

		expect(api.fork).not.toHaveBeenCalled();
		expect(api.prompt).not.toHaveBeenCalled();
		expect(controller.getView().draft).toBe("reworded");
		expect(controller.getView().error).not.toBeNull();
	});

	it("ends selected and attached to a Codex-shaped fork, which renames nothing (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.attach.mockClear();
		controller.setDraft("reworded");

		await controller.forkAndSubmit(0);

		// Codex leaves this client's adapter on the parent and the returned ref
		// has no adapter at all, so the client is what attaches it.
		expect(api.attach).toHaveBeenCalledWith(forkedRef);
		expect(controller.getView().state.selected).toEqual(forkedRef);
		expect(controller.getView().state.summaries.map((item) => item.ref)).toContainEqual(forkedRef);
	});

	/**
	 * Pi's own CLI abandons the in-flight turn on a mid-stream fork whatever the
	 * client does (OW-yudoni), so the abort is not what costs the reply -- it is
	 * what makes the loss deliberate and visible, under the label that warns
	 * about it (D15, OW-bakosi).
	 */
	it("stops a running Pi turn before forking it (D15, OW-bakosi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		controller.setDraft("reworded");

		await controller.forkAndSubmit(0);

		expect(api.abort).toHaveBeenCalledWith(ref);
		expect(api.abort.mock.invocationCallOrder[0]!).toBeLessThan(api.fork.mock.invocationCallOrder[0]!);
	});

	/**
	 * The other half of the same decision: a Codex or Claude parent survives a
	 * mid-stream fork with its whole reply durable (OW-gojado, OW-japuzo), so an
	 * abort there would destroy a reply nothing else was going to take. Forking
	 * is all an edit submitted mid-stream does on those backends (D15, OW-bakosi).
	 */
	it.each([["codex"], ["claude"]] as const)(
		"forks a streaming %s session without stopping its turn (D15, OW-bakosi)",
		async (backend) => {
			const parent: SessionRef = { backend, id: `${backend}-parent` };
			const api = new FakeApi();
			api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
			const controller = createController(api);
			await controller.start();
			await controller.select(parent);
			api.emit({ type: "snapshot", session: parent, handle: h(parent), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
			controller.setDraft("reworded");

			expect((await controller.forkAndSubmit(0))?.ref).toEqual(forkedRef);

			expect(api.abort).not.toHaveBeenCalled();
			expect(api.fork).toHaveBeenCalledWith(parent, { entryId: "turn-1" });
			expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded" });
			controller.dispose();
		},
	);

	/**
	 * A fork is a selection change, but not one that outranks a click that
	 * happened while it was in flight (OW-mifuki). The user gave up on *going to*
	 * the fork and went somewhere else -- and that is all they gave up on: under
	 * D17 the click is navigation, not a retraction, so the fork is still made,
	 * attached and prompted, and they end up with both conversations (OW-miyemo).
	 */
	it("lands a fork whose selection was overtaken by a click mid-flight, without moving the user (D17, OW-miyemo)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const forking = deferred<SessionRef>();
		api.fork.mockReturnValueOnce(forking.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await controller.select(other);
		forking.resolve(forkedRef);

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(api.attach).toHaveBeenCalledWith(forkedRef);
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded" });
		expect(controller.getView().state.selected).toEqual(other);
		controller.dispose();
	});

	/**
	 * The abort window, which had no test at all: removing that guard used to
	 * leave the whole client suite green. It is also the window where the old
	 * behaviour was worst in kind -- the button says "Stop and fork" on Pi, which
	 * this test's ref is (D15, OW-bakosi), so a click
	 * here killed the parent's turn the user *had* asked for and then abandoned
	 * the fork they had asked for too, leaving them with neither (D17, OW-miyemo).
	 */
	it("lands a fork whose selection was overtaken while the abort was in flight (D17, OW-miyemo)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const aborting = deferred<void>();
		api.abort.mockReturnValueOnce(aborting.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		expect(api.abort).toHaveBeenCalledWith(ref);
		await controller.select(other);
		aborting.resolve();

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-1" });
		expect(api.attach).toHaveBeenCalledWith(forkedRef);
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded" });
		expect(controller.getView().state.selected).toEqual(other);
		controller.dispose();
	});

	/** The `fork-points` window, the other one that had no test (D17, OW-miyemo). */
	it("lands a fork whose selection was overtaken while fork points were being read (D17, OW-miyemo)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const api = new FakeApi();
		const points = deferred<ForkPoint[]>();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		// After the select: attaching a session refreshes its fork points for the
		// transcript's Edit controls (OW-roveze), and that read is not this one.
		api.forkPoints.mockClear();
		api.forkPoints.mockReturnValueOnce(points.promise);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		expect(api.forkPoints).toHaveBeenCalledWith(ref);
		await controller.select(other);
		points.resolve([{ id: "turn-1", text: "first", index: 0 }]);

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-1" });
		expect(api.attach).toHaveBeenCalledWith(forkedRef);
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded" });
		expect(controller.getView().state.selected).toEqual(other);
		controller.dispose();
	});
	/**
	 * OW-lizohe. A session renamed while the refresh an attach started is in
	 * flight (D9) keeps its handle, which the refresh is keyed by, so the reply
	 * still passes the still-selected check (D24). Keyed by the name the session
	 * had when the request went out, the reply failed it and published nothing,
	 * so the transcript kept drawing Edit controls from the old set until the
	 * next turn boundary re-asked.
	 */
	it("publishes fork points for a session renamed while the refresh was in flight (OW-lizohe)", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };
		const api = new FakeApi();
		const points = deferred<ForkPoint[]>();
		api.forkPoints.mockReturnValueOnce(points.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		expect(api.forkPoints).toHaveBeenCalledWith(ref);

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		api.emit({ type: "status", session: renamed, handle: h(ref), seq: 2, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		points.resolve([{ id: "turn-1", text: "first", index: 0 }]);
		await settle();

		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().forkIndices).toEqual([0]);
		controller.dispose();
	});

	/**
	 * The sharp edge D17 names. A fork that takes the selection bumps
	 * `selectionIntent` to fence off a preview poll still in flight; a fork that
	 * declines it must not, because bumping past the user's own click strands it
	 * -- their `attachAndSelect` falls into its `else` branch, the selection is
	 * never set and `busy` sits on "attaching" under "Opening session..." forever.
	 */
	it("does not bump the selection intent past the click it declined to overtake (D17, OW-miyemo)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const forking = deferred<SessionRef>();
		api.fork.mockReturnValueOnce(forking.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		// The user's own attach is still in flight when the fork resolves and
		// runs its attach, its prompt and its publishes underneath it.
		const attachingOther = deferred<LiveSessionSummary>();
		api.attach.mockReturnValueOnce(attachingOther.promise);
		const selecting = controller.select(other);
		await settle();
		forking.resolve(forkedRef);
		expect((await submitted)?.ref).toEqual(forkedRef);
		attachingOther.resolve(summary(other));
		await selecting;

		expect(controller.getView().state.selected).toEqual(other);
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	/**
	 * The other side of the guard above: once the prompt has landed there is no
	 * abandoning it, whatever the user clicked. The fork is reported back so the
	 * caller can move its per-tab state onto the right session, and the draft is
	 * cleared even though the selection has moved -- one draft, one composer, and
	 * it must not go on offering text that was already sent (OW-mifuki).
	 */
	it("reports the fork it landed on, and clears the draft, when the click comes after the prompt (OW-mifuki)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		api.fork.mockResolvedValue(forkedRef);
		api.attach.mockImplementation(async (target: SessionRef) => summary(target));
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		expect(api.prompt).toHaveBeenCalledOnce();
		await controller.select(other);
		prompt.resolve();

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(controller.getView().draft).toBe("");
		expect(controller.getView().state.selected).toEqual(other);
	});

	/**
	 * The click that lands on the fork's *own* row, rather than away from it
	 * (OW-tatebi). The fork still declines the selection -- the user's click owns
	 * `selectionIntent` -- but `applyAttached`'s residual moves the selection
	 * anyway, because the selection it finds is already the fork. The live
	 * transcript then has to take over from the read-only preview that click
	 * opened, or the user reads a frozen copy of a session that is streaming.
	 */
	it("clears the preview when the click it declined to overtake landed on the fork itself (OW-tatebi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		api.fork.mockResolvedValue(forkedRef);
		api.preview.mockResolvedValue({ ref: forkedRef, turns: [previewAssistant("stale")] });
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const attachingFork = deferred<LiveSessionSummary>();
		api.attach.mockReturnValueOnce(attachingFork.promise);
		const submitted = controller.forkAndSubmit(0);
		await settle();
		// The fork is listed by now, and the click lands on it while its own
		// attach is still in flight.
		await controller.preview(forkedRef);
		expect(controller.getView().preview).not.toBeNull();
		attachingFork.resolve(summary(forkedRef));

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(controller.getView().state.selected).toEqual(forkedRef);
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	/**
	 * The rule `submit` has always had, brought to the fork path (OW-kelede).
	 * Two fast presses in edit mode -- Ctrl-Enter twice, or Enter then a click on
	 * the fork button -- used to start two whole forks, each one an abort against
	 * the parent, a `fork-points`, a `fork`, an `attach` and a `prompt`.
	 */
	it("forks once when the fork path is entered twice while the first is still in flight (OW-kelede)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const forking = deferred<SessionRef>();
		api.fork.mockReturnValue(forking.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		// The attach's own fork-points read (OW-roveze) is not one of the two this
		// test is counting.
		api.forkPoints.mockClear();
		controller.setDraft("reworded");

		const first = controller.forkAndSubmit(0);
		const second = controller.forkAndSubmit(0);
		await settle();

		expect(api.forkPoints).toHaveBeenCalledOnce();
		expect(api.fork).toHaveBeenCalledOnce();
		forking.resolve(forkedRef);
		expect(await second).toBeNull();
		expect((await first)?.ref).toEqual(forkedRef);
		expect(api.prompt).toHaveBeenCalledOnce();
		controller.dispose();
	});

	/**
	 * The fork's round trip is four requests deep where a plain submit is one, so
	 * the window in which the user types the next prompt into a live textarea is
	 * that much wider -- and the clear used to be unconditional and wipe it
	 * (OW-kelede). `submit`'s rule covers both cases at once: a click away does
	 * not change the draft, so that one still clears.
	 */
	it("keeps a draft typed while the fork was in flight (OW-kelede)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		api.attach.mockImplementation(async (target: SessionRef) => summary(target));
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		expect(api.prompt).toHaveBeenCalledOnce();
		controller.setDraft("and the next thing");
		prompt.resolve();

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(controller.getView().draft).toBe("and the next thing");
		controller.dispose();
	});

	/**
	 * `busy` is one global slot, so it never was a sound in-flight signal
	 * (OW-kelede): prompt a session, watch the turn start streaming ahead of the
	 * POST's own response (D2), press Stop, and `abort`'s `finally` publishes
	 * `"idle"` over the `"submitting"` of a prompt that is still outstanding.
	 * The guards read the flag the two send paths own instead.
	 */
	it("refuses a second submit after an abort cleared busy under the first (OW-kelede)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const first = controller.submit();
		await settle();

		await controller.abort();
		expect(controller.getView().busy).toBe("idle");
		const second = controller.submit();

		expect(api.prompt).toHaveBeenCalledOnce();
		prompt.resolve();
		expect(await second).toBe(false);
		await first;
		controller.dispose();
	});

	it("keeps the draft, and reports, when no fork point names that index (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("reworded");

		expect(await controller.forkAndSubmit(4)).toBeNull();

		expect(api.fork).not.toHaveBeenCalled();
		expect(api.prompt).not.toHaveBeenCalled();
		expect(controller.getView().draft).toBe("reworded");
		expect(controller.getView().error).not.toBeNull();
	});

	it("closes SSE and ignores later events after disposal", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		controller.dispose();

		api.emit({ type: "sessions-changed" });

		expect(api.connection.close).toHaveBeenCalledOnce();
		expect(api.listSessions).toHaveBeenCalledTimes(1);
	});

	/**
	 * The preview poll (OW-76). All of these drive the *real* `createController`
	 * with a fake api on purpose: `App.test.ts`'s `FakeController.preview` only
	 * records the call and never replaces `turns`, so a poll test written against
	 * it would assert call counts while proving nothing about the transcript.
	 */
	describe("preview self-refresh", () => {
		const otherRef: SessionRef = { backend: "codex", id: "thread-other" };

		function growingPreview(api: FakeApi, turns: () => SessionPreviewTurn[]) {
			api.preview.mockImplementation(async (session: SessionRef) => ({ ref: session, turns: turns() }));
		}

		it("polls a showing preview, speeds up on a change, and backs off to the ceiling", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
				growingPreview(api, () => turns);
				const controller = createController(api);
				await controller.preview(ref);
				api.preview.mockClear();

				// Starts quiet: nothing until the 16s idle delay is actually up.
				await vi.advanceTimersByTimeAsync(15_999);
				expect(api.preview).not.toHaveBeenCalled();
				turns = [...turns, previewAssistant("there")];
				await vi.advanceTimersByTimeAsync(1);
				expect(api.preview).toHaveBeenCalledTimes(1);
				expect(controller.getView().preview?.turns).toHaveLength(2);

				// Having found a change, the next fetch lands 1s later, not 16.
				turns = [...turns, { role: "user", content: "more" }];
				await vi.advanceTimersByTimeAsync(999);
				expect(api.preview).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(api.preview).toHaveBeenCalledTimes(2);
				expect(controller.getView().preview?.turns).toHaveLength(3);

				// Quiet from here: the gap stretches back out and then holds at 16s.
				let fetches = 2;
				for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000]) {
					await vi.advanceTimersByTimeAsync(delay - 1);
					expect(api.preview).toHaveBeenCalledTimes(fetches);
					await vi.advanceTimersByTimeAsync(1);
					fetches += 1;
					expect(api.preview).toHaveBeenCalledTimes(fetches);
				}

				// Polling never touches the selection, and never attaches.
				expect(controller.getView().state.selected).toEqual(ref);
				expect(api.attach).not.toHaveBeenCalled();
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("re-reads the preview when the sessions are refreshed, not just the sidebar", async () => {
			const api = new FakeApi();
			let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
			growingPreview(api, () => turns);
			const controller = createController(api);
			await controller.preview(ref);
			api.preview.mockClear();
			turns = [...turns, previewAssistant("there")];

			await controller.refreshSessions();

			expect(api.preview).toHaveBeenCalledTimes(1);
			expect(api.preview).toHaveBeenCalledWith(ref);
			expect(controller.getView().preview?.turns).toHaveLength(2);
			expect(controller.getView().state.selected).toEqual(ref);
			controller.dispose();
		});

		it("resets the poll to its fastest rate when a returning tab finds a change, and leaves it alone when it does not", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
				growingPreview(api, () => turns);
				const controller = createController(api);
				await controller.preview(ref);
				api.preview.mockClear();

				// What App.svelte's visibilitychange/focus listener calls.
				turns = [...turns, previewAssistant("there")];
				await controller.refreshPreview();
				expect(api.preview).toHaveBeenCalledTimes(1);
				expect(controller.getView().preview?.turns).toHaveLength(2);

				// A second gesture, this one finding nothing, must not back the delay
				// off: backoff measures how quiet the file is, and a gesture is not
				// evidence about that. Only a timer tick may stretch the gap.
				await controller.refreshPreview();
				expect(api.preview).toHaveBeenCalledTimes(2);

				// So the next *poll* still lands 1s after the change, not 16s and not 2s.
				await vi.advanceTimersByTimeAsync(999);
				expect(api.preview).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1);
				expect(api.preview).toHaveBeenCalledTimes(3);
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("never polls a hidden tab, and picks up again when it comes back", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				let visible = true;
				api.preview.mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				const controller = createController(api, () => visible);
				await controller.preview(ref);
				api.preview.mockClear();

				// The visibilitychange on the way *out* is the same call as on the way in.
				visible = false;
				await controller.refreshPreview();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(api.preview).not.toHaveBeenCalled();

				visible = true;
				await controller.refreshPreview();
				expect(api.preview).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(16_000);
				expect(api.preview).toHaveBeenCalledTimes(2);
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("stops polling on attach, and a fetch that lands afterwards cannot put the preview back", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				api.preview.mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				api.attach.mockResolvedValue(summary(attachedRef));
				const controller = createController(api);
				await controller.preview(ref);

				// A poll is in flight at the moment the user attaches.
				const late = deferred<SessionPreviewResponse>();
				api.preview.mockReturnValueOnce(late.promise);
				await vi.advanceTimersByTimeAsync(16_000);
				await controller.select(ref);
				expect(controller.getView().preview).toBeNull();

				late.resolve({ ref, turns: [{ role: "user", content: "hi" }, previewAssistant("late")] });
				await late.promise;
				await vi.advanceTimersByTimeAsync(0);
				expect(controller.getView().preview).toBeNull();

				api.preview.mockClear();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(api.preview).not.toHaveBeenCalled();
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("polls the session now on screen, at a fresh idle delay, after the user switches previews", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
				growingPreview(api, () => turns);
				const controller = createController(api);
				await controller.preview(ref);
				// Drive the first session's poll down to its fastest rate.
				turns = [...turns, previewAssistant("there")];
				await vi.advanceTimersByTimeAsync(16_000);

				await controller.preview(otherRef);
				api.preview.mockClear();

				// The busy session's 1s countdown does not carry over to the quiet one.
				await vi.advanceTimersByTimeAsync(15_999);
				expect(api.preview).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				expect(api.preview).toHaveBeenCalledTimes(1);
				expect(api.preview).toHaveBeenCalledWith(otherRef);
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not cancel a click that is still in flight when a poll fires", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				api.preview.mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				const controller = createController(api);
				await controller.preview(ref);

				// The user clicks another row, and its fetch is still in flight...
				const clicked = deferred<SessionPreviewResponse>();
				api.preview.mockReturnValueOnce(clicked.promise);
				const clicking = controller.preview(otherRef);
				// ...when the poll for the preview still on screen fires. A refresh is
				// not a new selection: it captures the selection intent rather than
				// bumping it, or it would silently cancel the click.
				await vi.advanceTimersByTimeAsync(16_000);

				clicked.resolve({ ref: otherRef, turns: [{ role: "user", content: "other" }] });
				await clicking;

				expect(controller.getView().state.selected).toEqual(otherRef);
				expect(controller.getView().preview).toEqual({
					ref: otherRef,
					turns: [{ role: "user", content: "other" }],
				});
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("stops polling after disposal", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				api.preview.mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				const controller = createController(api);
				await controller.preview(ref);
				api.preview.mockClear();

				controller.dispose();
				await vi.advanceTimersByTimeAsync(60_000);

				expect(api.preview).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
