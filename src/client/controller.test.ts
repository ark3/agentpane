import { describe, expect, it, vi } from "vitest";
import type {
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
import { createController, paneMode, type AgentpaneController } from "./controller.ts";
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

/**
 * The snapshot that introduces a live view of `session` in this tab, which is
 * the only thing that makes its pane live (OW-forinu): an attach reply alone
 * leaves it detached.
 */
function snapshotOf(session: SessionRef, handle = h(session)): ServerEvent {
	return { type: "snapshot", session, handle, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] };
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
		async (session: SessionRef, _signal?: AbortSignal): Promise<SessionPreviewResponse> => ({ ref: session, turns: [] }),
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
	readonly dismissError = vi.fn(async (_session: SessionRef, _errorId: string) => {});
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [{ role: "user", content: "done", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [{ role: "user", content: "done", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		await controller.preview(ref);

		expect(api.listModels).not.toHaveBeenCalled();
	});

	it("never sets a model once the conversation has a message", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);
		controller.setDraft("send while setting");

		const selecting = controller.setModel("opaque/next");
		expect(controller.getView()).toMatchObject({ busy: "idle", modelSetting: true });
		await controller.submit();
		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send while setting", priorErrorId: null });
		setting.resolve();
		await selecting;
	});

	it("sets an exact effort under its own pending flag, not the model's", async () => {
		const api = new FakeApi();
		const setting = deferred<void>();
		api.setEffort.mockReturnValue(setting.promise);
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: "medium", unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: "medium", unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		// No listing has named either, and an attach reply writes no `status`
		// (OW-wazija): the listing that follows each attach is what says attached.
		expect(controller.getView().state.summaries).toEqual([
			{ ...summary(secondRef), status: "detached" },
			{ ...summary(firstRef), status: "detached" },
		]);
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
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
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
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("send me");

		await controller.submit();

		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send me", priorErrorId: null });
		expect(controller.getView().draft).toBe("");
	});

	it("ignores a second submit while the first prompt is still in flight", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
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
		api.emit(snapshotOf(ref));
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
		api.emit(snapshotOf(ref));
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
		api.listSessions.mockReturnValueOnce(listed.promise).mockRejectedValueOnce(new Error("list is down"));
		api.emit({ type: "sessions-changed" });

		// The press waits on the listing owed after the silent one (OW-sabova)
		// rather than starting its own, so this is the only thing that can report
		// that listing's failure to the user. The silent one's stays silent.
		const errors: (string | null)[] = [];
		controller.subscribe((next) => errors.push(next.error));
		const pressed = controller.refreshSessions();
		listed.reject(new Error("silent listing failed"));
		await pressed;

		expect(api.listSessions).toHaveBeenCalledTimes(3);
		expect(errors).not.toContain("silent listing failed");
		expect(controller.getView().error).toBe("list is down");
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// A press that joins owns what it owned before OW-sabova and no more: the
	// owed listing's failure and its idle, never a `busy: "listing"` or cleared
	// error at the owed listing's start, which comes after the press and so
	// possibly after a gesture the user made in between (OW-nasofa).
	for (const attach of ["pending", "failed"] as const) {
		it(`leaves an attach made after a joining Refresh its ${attach === "pending" ? "busy" : "error"} when the owed listing starts (OW-sabova)`, async () => {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			const listed = deferred<SessionSummary[]>();
			const owed = deferred<SessionSummary[]>();
			api.listSessions.mockReturnValueOnce(listed.promise).mockReturnValueOnce(owed.promise);
			const attached = deferred<LiveSessionSummary>();
			api.attach.mockReturnValueOnce(attached.promise);
			api.emit({ type: "sessions-changed" });

			const pressed = controller.refreshSessions();
			const selecting = controller.select(ref);
			if (attach === "failed") {
				attached.reject(new Error("attach failed"));
				await selecting;
			}
			listed.resolve([summary(ref)]);
			await settle();

			expect(api.listSessions).toHaveBeenCalledTimes(3);
			expect(controller.getView()).toMatchObject(
				attach === "pending" ? { busy: "attaching" } : { busy: "idle", error: "attach failed" },
			);
			if (attach === "pending") {
				attached.resolve(summary(ref));
				await selecting;
				expect(controller.getView().busy).toBe("idle");
			}
			owed.resolve([summary(ref)]);
			await pressed;
			expect(controller.getView().busy).toBe("idle");
			if (attach === "failed") expect(controller.getView().error).toBe("attach failed");
			controller.dispose();
		});
	}

	it("keeps a draft typed while the prompt is in flight", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("send me");

		const submitted = controller.submit();
		controller.setDraft("the next thing I want to say");
		prompt.resolve();
		await submitted;

		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send me", priorErrorId: null });
		expect(controller.getView().draft).toBe("the next thing I want to say");
	});

	it("aborts the current authoritative selected ref", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(attachedRef));

		await controller.abort();

		expect(api.abort).toHaveBeenCalledWith(attachedRef);
	});

	it("updates selection from the snapshot that introduces a session under a ref its attach reply did not name", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };

		api.emit({ type: "snapshot", session: renamed, handle: h(ref), seq: 2, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().state.summaries.map((item) => item.ref)).toContainEqual(renamed);
		expect(viewAt(controller, renamed)?.seq).toBe(2);
	});

	// D25 point 5: a gap detaches the session in this tab, and nothing attaches
	// it on the client's behalf -- an attach is what spawns, and the user clicking
	// the row is the deliberate one. However many events gap, none attaches.
	it("detaches a selected session whose sequence gaps and lands on its preview, without attaching it (OW-lunihe)", async () => {
		const api = new FakeApi();
		api.abort.mockRejectedValueOnce(new Error("abort failed"));
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		await controller.abort();
		api.attach.mockClear();

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 4, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(api.attach).not.toHaveBeenCalled();
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).toBe("preview");
		expect(controller.getView().preview).toEqual({ ref, turns: [] });
		// Not a gesture, so it empties no mail the user has not read.
		expect(controller.getView().error).toBe("abort failed");
		controller.dispose();
	});

	// Unlike detach()'s no-disk exit, the server still holds the session, so the
	// empty preview's Attach reaches it and the poll finds the first turn's file.
	it("lands a gapped selection with nothing on disk on its preview (OW-lunihe)", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValueOnce({ ...summary(ref), onDisk: false });
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		api.attach.mockClear();
		api.preview.mockClear();

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(api.attach).not.toHaveBeenCalled();
		expect(api.preview).toHaveBeenCalledWith(ref, expect.any(AbortSignal));
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().preview).toEqual({ ref, turns: [] });
		controller.dispose();
	});

	// The reducer returns on a gap before it moves anything, so the selection
	// still names the old ref; the gapped event's is the session's current one.
	it("previews the ref a gapped event renamed the session to (OW-lunihe)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		api.preview.mockClear();
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };

		api.emit({ type: "status", session: renamed, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(api.preview).toHaveBeenCalledWith(renamed, expect.any(AbortSignal));
		expect(api.preview.mock.calls.map(([session]) => session)).not.toContainEqual(ref);
		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().preview).toEqual({ ref: renamed, turns: [] });
		controller.dispose();
	});

	// A failed read is never an answer (OW-bilogo): the selection stands, and
	// the failure is the pane's to show.
	it("keeps a gapped selection detached-loading when its preview cannot be read, reporting it on the pane (OW-lunihe, OW-bilogo)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		api.preview.mockRejectedValueOnce(new Error("preview failed"));

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).toBe("loading");
		expect(controller.getView().previewFailure).toEqual({ ref, message: "preview failed" });
		// Nobody asked for that preview, so the error slot is not its to write.
		expect(controller.getView().error).toBeNull();
		controller.dispose();
	});

	// The gap takes no intent, so a click made before it is still the user's
	// last word: its attach landing first is not overwritten by the gap's preview.
	it("leaves the selection on a row clicked before the gap when the gap's preview lands after it (OW-lunihe)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		const previewing = deferred<SessionPreviewResponse>();
		api.preview.mockReturnValueOnce(previewing.promise);
		const attaching = deferred<LiveSessionSummary>();
		api.attach.mockReturnValueOnce(attaching.promise);

		const selecting = controller.select(attachedRef);
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		attaching.resolve(summary(attachedRef));
		await selecting;
		previewing.resolve({ ref, turns: [] });
		await settle();

		expect(controller.getView().state.selected).toEqual(attachedRef);
		// The click's own row loaded its preview, and the gap's never replaced it.
		expect(controller.getView().preview).toEqual({ ref: attachedRef, turns: [] });
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// Another client's attach snapshots the session to every client, which
	// brings its live view back here while the gap's preview is out.
	it("keeps a gapped session live when a snapshot re-introduces it before its preview lands (OW-lunihe)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		const previewing = deferred<SessionPreviewResponse>();
		api.preview.mockReturnValueOnce(previewing.promise);

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		previewing.resolve({ ref, turns: [] });
		await settle();

		expect(controller.getView().state.sessions[h(ref)]).toBeDefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	// The attach reply and its snapshot are unordered (D2), so the gap's preview
	// can resolve between them, when the selection names the session and no
	// view is back yet. It lands then, and the snapshot outranks it (`paneMode`).
	it("goes live over the gap's preview once the attach of the same session made while it was out brings its snapshot (OW-lunihe, OW-forinu)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await settle();
		api.preview.mockClear();
		const previewing = deferred<SessionPreviewResponse>();
		api.preview.mockReturnValueOnce(previewing.promise);

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await controller.select(ref);
		previewing.resolve({ ref, turns: [] });
		await settle();

		// The reply beat its snapshot, and in that window the pane is not live,
		// whatever it shows: one read, the gap's, served both.
		expect(api.preview).toHaveBeenCalledOnce();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).not.toBe("live");

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		expect(controller.getView().state.sessions[h(ref)]).toBeDefined();
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	it("keeps the error slot through a sequence gap (OW-yasewo)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.submit();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(api.attach).not.toHaveBeenCalled();
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");
		controller.dispose();
	});

	// `busy` is one global slot and a gap is per-session, so a gap on B must not
	// write over the prompt the user is watching in A, nor move the selection
	// off it; re-attaching B used to write "Opening session…" there.
	it("leaves busy at submitting and the selection in place across another session's sequence gap (OW-yasewo)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("hello");
		const submitted = controller.submit();

		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "status", session: attachedRef, handle: h(attachedRef), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(controller.getView().state.sessions[h(attachedRef)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().busy).toBe("submitting");
		prompt.resolve();
		await submitted;
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// A regression guard, not a red-first test: since OW-kelede the send guard
	// reads `sending`, which a gap does not touch. Nothing else pins a gap
	// against that guard, and the guard has moved once already.
	it("ignores a second submit while another session's sequence gaps (OW-yasewo)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("hello");
		const first = controller.submit();

		api.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "status", session: attachedRef, handle: h(attachedRef), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();
		const second = controller.submit();

		expect(api.prompt).toHaveBeenCalledOnce();
		prompt.resolve();
		await Promise.all([first, second]);
		controller.dispose();
	});

	it("does not select a session whose sequence gaps, nor touch the preview on screen", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();
		expect(controller.getView().state.selected).toBeNull();
		expect(controller.getView().preview).toBeNull();

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(attachedRef);
		api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(api.preview).toHaveBeenCalledOnce();
		controller.dispose();
	});

	// A broadcast that joins a listing already out is owed a fresh one, since the
	// answer it joined may predate the change it announces -- but a burst of them
	// owes exactly one, however long it is (OW-sabova).
	it("coalesces a burst of session-list refreshes into one owed listing", async () => {
		const api = new FakeApi();
		const listed = deferred<SessionSummary[]>();
		const owed = deferred<SessionSummary[]>();
		const controller = createController(api);
		await controller.start();
		api.listSessions.mockClear();
		api.listSessions.mockReturnValueOnce(listed.promise).mockReturnValueOnce(owed.promise);

		api.emit({ type: "sessions-changed" });
		api.emit({ type: "sessions-changed" });
		api.emit({ type: "sessions-changed" });
		api.emit({ type: "sessions-changed" });

		expect(api.listSessions).toHaveBeenCalledTimes(1);
		listed.resolve([summary(attachedRef)]);
		await settle();
		expect(controller.getView().state.summaries).toEqual([summary(attachedRef)]);
		expect(api.listSessions).toHaveBeenCalledTimes(2);

		owed.resolve([summary(ref)]);
		await settle();
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		expect(api.listSessions).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	// The attach reply leaves the row's `status` to the listing (OW-wazija), and
	// the attach's own broadcast is what brings that listing. When a listing is
	// already out as the user attaches, the broadcast joins it, and its answer --
	// given before the attach -- says `detached`; the current row carries that
	// too, so only a listing asked after this one can light the row (OW-sabova).
	it("lights the row of a session attached while a listing was in flight (OW-sabova)", async () => {
		const api = new FakeApi();
		const detached = { ...summary(ref), status: "detached" as const };
		api.listSessions.mockResolvedValueOnce([detached]);
		const controller = createController(api);
		await controller.start();
		api.open();
		const listed = deferred<SessionSummary[]>();
		api.listSessions.mockReturnValueOnce(listed.promise);
		api.emit({ type: "sessions-changed" });
		expect(api.listSessions).toHaveBeenCalledTimes(2);

		await controller.select(ref);
		api.emit(snapshotOf(ref));
		api.emit({ type: "sessions-changed" });
		expect(api.listSessions).toHaveBeenCalledTimes(2);
		listed.resolve([detached]);
		await settle();

		expect(api.listSessions).toHaveBeenCalledTimes(3);
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		controller.dispose();
	});

	it("forgets a cached live session when a fresh listing reports it detached", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
	// re-list is what `replaceSessionSummaries` drops a live view from, and until
	// the view goes the pane reads live and nothing fetches its preview, so
	// whichever wins the race the view has to be gone and the preview on screen.
	for (const relistFirst of [true, false]) {
		const when = relistFirst ? "before" : "after";
		it(`detaches the selected session onto its read-only preview, with the re-list landing ${when} the preview`, async () => {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
			expect(api.preview).toHaveBeenCalledWith(ref, expect.any(AbortSignal));
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
			expect(paneMode(detachedView)).toBe("preview");
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
	// no broadcast is needed anywhere in this test. The row is lit by a Refresh
	// taken after the drop, because the drop itself reads every row detached
	// (D25) and an attach reply lights nothing (OW-wazija): only a listing lit
	// while the stream is still down is one only the reconnect can put out.
	it("clears a detached row's stripe at the reconnect when no broadcast followed the detach", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();

		api.drop();
		await controller.refreshSessions();
		await controller.select(ref);
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		const detachedSummary = { ...summary(ref), status: "detached" as const, isStreaming: false };
		api.listSessions.mockResolvedValue([detachedSummary]);
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

	const virtualRef: SessionRef = { backend: "codex", id: "virtual:new" };
	const storedRef: SessionRef = { backend: "pi", id: "/sessions/stored.jsonl" };

	function opening(session: SessionRef, handle = h(session)): ServerEvent {
		return { type: "snapshot", session, handle, seq: 1, messages: [{ role: "user", content: "hello", timestamp: 1 }], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] };
	}

	// A drop is taken to mean the server exited and every agent with it (D25),
	// so the tab holds nothing live the moment it happens, rather than waiting
	// for the reconnect's listing to pair each view with a `detached` summary --
	// which a restarted server never lists for a view a rename moved (OW-fiheli).
	// A selection with a transcript on disk stays, on the detached-loading pane,
	// whose preview waits for a server that can answer it (OW-forinu).
	for (const fatal of [false, true]) {
		it(`drops every live view at once, leaving the selection detached, when the stream drops${fatal ? " fatally" : ""}`, async () => {
			const api = new FakeApi();
			const streaming = { ...summary(ref), isStreaming: true };
			const virtual = { ...summary(virtualRef), status: "virtual" as const, onDisk: false };
			const fileless = { ...summary(forkedRef), onDisk: false };
			const stored: SessionSummary = { ...summary(storedRef), status: "detached" };
			delete stored.handle;
			api.listSessions.mockResolvedValue([streaming, summary(attachedRef), virtual, fileless, stored]);
			const controller = createController(api);
			await controller.start();
			api.open();
			api.emit(opening(ref));
			api.emit(opening(attachedRef));
			await controller.preview(attachedRef);
			controller.setDraft("sent to nobody");
			expect(Object.keys(controller.getView().state.sessions)).toHaveLength(2);

			api.preview.mockClear();

			api.drop(fatal);

			expect(controller.getView().state.sessions).toEqual({});
			expect(controller.getView().state.selected).toEqual(attachedRef);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(api.preview).not.toHaveBeenCalled();
			// The rows say so too: nothing on disk is gone with the server, and the
			// rest read detached and idle, keeping the handle a reconnect's opening
			// snapshot pairs by.
			expect(controller.getView().state.summaries).toEqual([
				{ ...streaming, status: "detached", isStreaming: false },
				{ ...summary(attachedRef), status: "detached" },
				stored,
			]);
			expect(await controller.submit()).toBe(false);
			expect(api.prompt).not.toHaveBeenCalled();
			controller.dispose();
		});
	}

	// Nothing on disk went with the server: there is nothing left to preview,
	// and the preview the server would answer is an empty one whose Attach can
	// only 404 (OW-vasubu), so the selection goes with the row.
	it("clears a live selection with nothing on disk when the stream drops", async () => {
		const api = new FakeApi();
		api.listSessions.mockResolvedValue([{ ...summary(forkedRef), onDisk: false }]);
		const controller = createController(api);
		await controller.start();
		api.open();
		api.emit(opening(forkedRef));
		await controller.preview(forkedRef);
		expect(paneMode(controller.getView())).toBe("live");
		api.preview.mockClear();

		api.drop();
		expect(controller.getView().state.summaries).toEqual([]);
		api.open();
		await settle();

		expect(controller.getView().state.selected).toBeNull();
		expect(api.preview).not.toHaveBeenCalled();
		controller.dispose();
	});

	// A preview is not live, so the drop leaves it on screen with its Attach,
	// and its own poll re-reads it once the server answers again.
	it("keeps a stored session's preview through a drop", async () => {
		const api = new FakeApi();
		const turns = [previewAssistant("stored")];
		api.preview.mockResolvedValue({ ref: attachedRef, turns });
		const controller = createController(api);
		await controller.start();
		api.open();
		api.emit(opening(ref));
		await controller.preview(attachedRef);

		api.drop();

		expect(controller.getView().state.sessions).toEqual({});
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().preview).toEqual({ ref: attachedRef, turns });
		controller.dispose();
	});

	// A previewed row the drop removes has nothing to preview or attach once
	// the server is back (OW-vasubu), so the selection goes with the row.
	it("clears a previewed selection whose row the drop removes", async () => {
		const api = new FakeApi();
		api.listSessions.mockResolvedValue([{ ...summary(virtualRef), status: "virtual", onDisk: false }]);
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.preview(virtualRef);
		expect(controller.getView().preview).not.toBeNull();

		api.drop();

		expect(controller.getView().state.summaries).toEqual([]);
		expect(controller.getView().state.selected).toBeNull();
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	// A rename that landed while the stream was down reaches this client only
	// as the opening snapshot under the same handle, carrying the new ref; with
	// the view gone, the summary's kept handle is what that snapshot pairs by
	// (`followRef`, D24).
	it("follows a rename made during the outage onto the row the drop kept", async () => {
		const api = new FakeApi();
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };
		const controller = createController(api);
		await controller.start();
		api.open();
		api.emit(opening(ref));
		api.drop();

		api.open();
		api.emit(opening(renamed, h(ref)));

		expect(controller.getView().state.summaries.map((item) => item.ref)).toEqual([renamed]);
		expect(viewAt(controller, renamed)).toBeDefined();
		controller.dispose();
	});

	// The reconnect publishes `connected` before its opening snapshots arrive,
	// so App's auto-select can ask for a preview of a session the snapshot then
	// re-introduces while the fetch is out. The pane reads live over it either
	// way (`paneMode`), and the reselect is what gives the live selection its
	// model list and pending flags.
	it("reselects the live session when a snapshot introduces it during its preview fetch", async () => {
		const api = new FakeApi();
		const fetch = deferred<SessionPreviewResponse>();
		api.preview.mockReturnValue(fetch.promise);
		const controller = createController(api);
		await controller.start();
		api.open();

		const previewing = controller.preview(ref);
		api.emit(opening(ref));
		fetch.resolve({ ref, turns: [previewAssistant("stale")] });
		await previewing;

		expect(controller.getView().preview).toBeNull();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(viewAt(controller, ref)).toBeDefined();
		controller.dispose();
	});

	// A drop the server survived still costs the tab its views, and the
	// server's opening snapshots at the reconnect are what put back each one it
	// still holds (D25).
	it("re-introduces a session the server still holds from the reconnect's opening snapshot", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		api.emit(opening(ref));
		api.drop();
		expect(viewAt(controller, ref)).toBeUndefined();

		api.open();
		api.emit(opening(ref));

		expect(viewAt(controller, ref)?.messages).toHaveLength(1);
		controller.dispose();
	});

	// The first open is `start()`'s own listing arriving by another door: the
	// native `EventSource` fires `onopen` on the initial connect as well as on
	// every re-establish, and nothing coalesces with a listing that has already
	// landed -- an open after the startup listing resolves would list a second
	// time (OW-vukoku).
	it("does not list a second time on the first open", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		// Load-bearing, not decoration: it drains `refreshInFlight`, so the open
		// below lands after the startup listing rather than inside it, where it
		// would be owed a fresh listing (OW-sabova) and this would test that
		// instead.
		await settle();
		expect(api.listSessions).toHaveBeenCalledOnce();

		api.open();
		await settle();

		expect(api.listSessions).toHaveBeenCalledOnce();
		controller.dispose();
	});

	// A first open inside the startup listing is owed one listing after it, like
	// every call that arrives while a listing is out (OW-sabova).
	it("lists once more after the startup listing when the first open lands inside it", async () => {
		const api = new FakeApi();
		const listed = deferred<SessionSummary[]>();
		api.listSessions.mockReturnValueOnce(listed.promise);
		const controller = createController(api);
		const starting = controller.start();

		api.open();
		expect(api.listSessions).toHaveBeenCalledOnce();
		listed.resolve([]);
		await starting;
		await settle();

		expect(api.listSessions).toHaveBeenCalledTimes(2);
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
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
	// The stream is down here and no event is emitted; the session is created
	// after the drop, which would otherwise have taken its selection down (D25).
	it("drops the phantom row of a detached session with nothing on disk, with no broadcast to ride on", async () => {
		const api = new FakeApi();
		createRenamedAtAttach(api, false);
		const controller = createController(api);
		await controller.start();
		api.drop();
		await controller.create("/work", "pi");
		expect(controller.getView().state.summaries.map((item) => sessionKey(item.ref))).toContain(sessionKey(createdRef));
		api.listSessions.mockResolvedValue([]);

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
		api.open();
		await controller.create("/work", "pi");
		api.emit({ type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		expect(controller.getView().state.selected).toEqual(createdRef);
		await settle();
		api.preview.mockClear();

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
		api.open();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("reworded");
		expect((await controller.forkAndSubmit(0))?.ref).toEqual(forkedRef);
		api.emit({ type: "snapshot", session: forkedRef, handle: h(forkedRef), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		expect(controller.getView().state.selected).toEqual(forkedRef);
		await settle();
		api.preview.mockClear();

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
		api.open();
		await controller.create("/work", "pi");
		api.emit({ type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.listSessions.mockResolvedValue([{ ...summary(createdRef), onDisk: true }]);
		api.emit({ type: "sessions-changed" });
		await settle();
		api.preview.mockClear();

		await controller.detach();
		await settle();

		expect(api.preview).toHaveBeenCalledWith(createdRef, expect.any(AbortSignal));
		expect(controller.getView().state.selected).toEqual(createdRef);
		controller.dispose();
	});

	it("leaves the selection where a click landed it while the detach's close was still in flight", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		const closing = deferred<void>();
		api.close.mockReturnValueOnce(closing.promise);

		const detaching = controller.detach();
		await settle();
		await controller.preview(attachedRef);
		expect(controller.getView().state.selected).toEqual(attachedRef);

		closing.resolve();
		await detaching;

		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(api.preview.mock.calls.map(([session]) => session)).not.toContainEqual(ref);
		controller.dispose();
	});

	// A gap inside a detach's window used to re-attach, spawning the subprocess
	// the user just asked to be rid of (OW-sugome); since D25 a gap attaches
	// nothing, and the detach still ends where it would have.
	it("does not re-attach a session whose detach is still in flight when its sequence gaps", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		api.open();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().preview).toEqual({ ref, turns: [] });
		controller.dispose();
	});

	it("does not forget or demote a session updated while a detached listing is in flight", async () => {
		const api = new FakeApi();
		const listed = deferred<SessionSummary[]>();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.listSessions.mockClear();
		// The second broadcast is owed a listing of its own (OW-sabova), held so
		// that what is asserted below is the first listing's landing alone.
		const owed = deferred<SessionSummary[]>();
		api.listSessions.mockReturnValueOnce(listed.promise).mockReturnValueOnce(owed.promise);

		api.emit({ type: "sessions-changed" });
		api.emit({ type: "sessions-changed" });
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 2, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		const detached = { ...summary(ref), status: "detached" as const, isStreaming: false };
		listed.resolve([detached]);
		await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));

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

	it("keeps a session's turn error through its prompt's reply until the server says it cleared it (OW-lohubo)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");

		controller.setDraft("try again");
		await controller.submit();

		// The reply alone drops nothing: the server owns the error.
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");
		api.emit({ type: "error-cleared", session: ref, handle: h(ref), seq: 3 });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
	});

	it("keeps an error with the held text that the new turn raised before its prompt's reply (OW-lohubo)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// The server admits the prompt and clears the error, then the new turn
		// fails at once with the same text, all before the reply (D2).
		api.emit({ type: "error-cleared", session: ref, handle: h(ref), seq: 3 });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 4, message: "The turn ended in an error.", errorId: "e2" });
		prompt.resolve();
		await submitted;

		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");
	});

	it("does not clear a fresh same-turn error that races in via SSE before the prompt POST resolves (D2)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// A genuine error for *this* turn arrives before the POST's own response does.
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "This turn just failed.", errorId: "e1" });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });

		controller.clearError();

		expect(controller.getView().error).toBeNull();
		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
		// The server holds the error too, and would put it back on the next
		// snapshot if it were not told (OW-bipume).
		// It names the error it dismisses, so a newer one the server holds by
		// then is left standing.
		expect(api.dismissError).toHaveBeenCalledExactlyOnceWith(ref, "e1");
	});

	it("dismisses the error on screen by the id the wire named it by, not its text (OW-jokoto)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "The turn ended in an error.", errorId: "e7", notices: [] });

		controller.clearError();

		expect(api.dismissError).toHaveBeenCalledExactlyOnceWith(ref, "e7");
	});

	it("sends with a prompt the id of the error on screen when the user sent it (OW-jokoto)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e7" });

		controller.setDraft("try again");
		await controller.submit();

		expect(api.prompt).toHaveBeenCalledExactlyOnceWith(ref, { text: "try again", priorErrorId: "e7" });
	});

	it("drops an error a snapshot redrew after its dismissal once the server says it cleared it (OW-jopifu)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		api.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });

		controller.clearError();
		// A snapshot the server broadcast before the dismissal reached it.
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "The turn ended in an error.", errorId: "e1", notices: [] });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");
		api.emit({ type: "error-cleared", session: ref, handle: h(ref), seq: 1 });

		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
	});

	it("tells the server nothing when the selected session holds no error to dismiss (OW-bipume)", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		api.emit(snapshotOf(ref));

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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("reworded");

		await controller.forkAndSubmit(2);

		expect(api.forkPoints).toHaveBeenCalledWith(ref);
		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-2" });
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded", priorErrorId: null });
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
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
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
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
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
		api.emit(snapshotOf(ref));
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
			api.emit({ type: "snapshot", session: parent, handle: h(parent), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
			controller.setDraft("reworded");

			expect((await controller.forkAndSubmit(0))?.ref).toEqual(forkedRef);

			expect(api.abort).not.toHaveBeenCalled();
			expect(api.fork).toHaveBeenCalledWith(parent, { entryId: "turn-1" });
			expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded", priorErrorId: null });
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
		api.emit(snapshotOf(ref));
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await controller.select(other);
		forking.resolve(forkedRef);

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(api.attach).toHaveBeenCalledWith(forkedRef);
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded", priorErrorId: null });
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
		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		expect(api.abort).toHaveBeenCalledWith(ref);
		await controller.select(other);
		aborting.resolve();

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-1" });
		expect(api.attach).toHaveBeenCalledWith(forkedRef);
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded", priorErrorId: null });
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
		api.emit(snapshotOf(ref));
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
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded", priorErrorId: null });
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

		api.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		api.emit(snapshotOf(ref));
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
		api.emit(snapshotOf(ref));
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
	 * opened, or the user reads a frozen copy of a session that is streaming;
	 * it does once the fork's snapshot gives this tab a view (`paneMode`,
	 * OW-forinu), and the preview stays until then only because nothing live
	 * has replaced it.
	 */
	it("goes live over the preview the declined click opened on the fork itself, once the fork's snapshot lands (OW-tatebi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
		api.fork.mockResolvedValue(forkedRef);
		api.preview.mockResolvedValue({ ref: forkedRef, turns: [previewAssistant("stale")] });
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
		controller.setDraft("reworded");

		const attachingFork = deferred<LiveSessionSummary>();
		api.attach.mockReturnValueOnce(attachingFork.promise);
		const submitted = controller.forkAndSubmit(0);
		await settle();
		// The fork is listed by now, and the click lands on it while its own
		// attach is still in flight.
		await controller.preview(forkedRef);
		expect(paneMode(controller.getView())).toBe("preview");
		attachingFork.resolve(summary(forkedRef));

		expect((await submitted)?.ref).toEqual(forkedRef);
		expect(controller.getView().state.selected).toEqual(forkedRef);
		api.emit(snapshotOf(forkedRef));
		expect(paneMode(controller.getView())).toBe("live");
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
		api.emit(snapshotOf(ref));
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
		api.emit(snapshotOf(ref));
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
		api.emit(snapshotOf(ref));
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
		await controller.start();
		await controller.select(ref);
		api.emit(snapshotOf(ref));
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

	/**
	 * The pane's mode is derived from what the tab holds for the selected
	 * session, live first (OW-forinu): each path that adds or drops a view used
	 * to keep a stored preview paired with it by hand, and these are the
	 * orderings where that pairing slipped.
	 */
	describe("the pane's mode", () => {
		// Another client closes S while S is selected here; the stream is up, so
		// the server answers the preview S's pane now needs.
		it("previews a selected session a listing evicts, and sends it nothing (OW-zivamo)", async () => {
			const api = new FakeApi();
			const turns = [previewAssistant("stored")];
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			expect(paneMode(controller.getView())).toBe("live");
			api.preview.mockClear();
			api.preview.mockResolvedValue({ ref, turns });
			api.listSessions.mockResolvedValueOnce([{ ...summary(ref), status: "detached", isStreaming: false }]);

			api.emit({ type: "sessions-changed" });
			await settle();

			expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
			expect(paneMode(controller.getView())).toBe("preview");
			expect(api.preview).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal));
			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.setDraft("sent to nobody");
			expect(await controller.submit()).toBe(false);
			expect(api.prompt).not.toHaveBeenCalled();
			controller.dispose();
		});

		// The server answered the attach just before it exited, and the tab handled
		// the stream's error before the reply (D25 point 3).
		for (const path of ["select", "create", "forkAndSubmit"] as const) {
			it(`lands an attach reply that follows a stream drop on a pane that is not live, through ${path} (OW-wazija)`, async () => {
				const api = new FakeApi();
				api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first", index: 0 }]);
				const created: SessionRef = { backend: "pi", id: "virtual:created" };
				api.createSession.mockResolvedValue(created);
				const controller = createController(api);
				await controller.start();
				api.open();
				if (path === "forkAndSubmit") {
					await controller.select(ref);
					api.emit(snapshotOf(ref));
					controller.setDraft("reworded");
				}
				const target = path === "select" ? ref : path === "create" ? created : forkedRef;
				const attaching = deferred<LiveSessionSummary>();
				api.attach.mockReturnValueOnce(attaching.promise);

				const landing = path === "select"
					? controller.select(ref)
					: path === "create"
						? controller.create("/work", "pi")
						: controller.forkAndSubmit(0);
				await settle();
				expect(api.attach).toHaveBeenLastCalledWith(target);
				api.drop();
				attaching.resolve({ ...summary(target), onDisk: path === "select" });
				await landing;
				await settle();

				const landed = controller.getView();
				expect(landed.state.selected).toEqual(target);
				expect(paneMode(landed)).not.toBe("live");
				expect(landed.state.summaries.filter((item) => item.status === "attached")).toEqual([]);
				expect(landed.busy).toBe("idle");
				api.prompt.mockClear();
				controller.setDraft("sent to nobody");
				expect(await controller.submit()).toBe(false);
				expect(api.prompt).not.toHaveBeenCalled();
				controller.dispose();
			});
		}

		// The attach's snapshot beats its reply (D2), a gap then drops the view it
		// made, and only then does the reply select the session.
		it("lands an attach whose snapshot's view a gap dropped before the reply on the detached-loading pane (OW-tefigi)", async () => {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			api.open();
			const previewing = deferred<SessionPreviewResponse>();
			api.preview.mockReturnValue(previewing.promise);
			const attaching = deferred<LiveSessionSummary>();
			api.attach.mockReturnValueOnce(attaching.promise);

			const selecting = controller.select(ref);
			api.emit(snapshotOf(ref));
			api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
			attaching.resolve(summary(ref));
			await selecting;

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(api.preview).toHaveBeenCalledWith(ref, expect.any(AbortSignal));
			controller.setDraft("sent to nobody");
			expect(await controller.submit()).toBe(false);
			expect(api.prompt).not.toHaveBeenCalled();
			controller.dispose();
		});

		// Another client's attach, a gap on the selected session followed by any
		// snapshot of it, or a reconnect's opening snapshot over a kept preview.
		it("goes live when a snapshot introduces a view of the session whose preview is on screen (OW-tefigi)", async () => {
			const api = new FakeApi();
			api.preview.mockResolvedValue({ ref, turns: [previewAssistant("stored")] });
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.preview(ref);
			expect(paneMode(controller.getView())).toBe("preview");

			api.emit(snapshotOf(ref));

			expect(paneMode(controller.getView())).toBe("live");
			// Discarded, not merely outranked, so its poll has nothing to re-read.
			expect(controller.getView().preview).toBeNull();
			controller.dispose();
		});

		// The read was out when the stream dropped, and fails only after the
		// reconnect. The reconnect's `connected` abandons it and asks a fresh
		// read (OW-bilogo): one asked before the outage is not what the
		// transition waits on, so its failure neither holds nor writes a line.
		it("asks a fresh preview at the reconnect when a read the stream dropped under is still out, and ignores that read's failure (OW-forinu, OW-bilogo)", async () => {
			const api = new FakeApi();
			const turns = [previewAssistant("stored")];
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			await settle();
			const outage = deferred<SessionPreviewResponse>();
			const fresh = deferred<SessionPreviewResponse>();
			api.preview.mockClear();
			api.preview.mockReturnValueOnce(outage.promise);
			api.preview.mockReturnValueOnce(fresh.promise);

			api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			expect(api.preview).toHaveBeenCalledOnce();
			api.drop();
			api.open();

			expect(api.preview).toHaveBeenCalledTimes(2);
			expect(api.preview.mock.calls[0]?.[1]?.aborted).toBe(true);
			outage.reject(new TypeError("Failed to fetch"));
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(controller.getView().previewFailure).toBeNull();

			fresh.resolve({ ref, turns });
			await settle();

			expect(api.preview).toHaveBeenCalledTimes(2);
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// The abandoned read answers after all, while the fresh one is still out:
		// what it read predates the outage, so it opens nothing.
		it("opens nothing from a read the reconnect abandoned, even one that succeeds late (OW-bilogo)", async () => {
			const api = new FakeApi();
			const turns = [previewAssistant("fresh")];
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			await settle();
			const outage = deferred<SessionPreviewResponse>();
			const fresh = deferred<SessionPreviewResponse>();
			api.preview.mockClear();
			api.preview.mockReturnValueOnce(outage.promise);
			api.preview.mockReturnValueOnce(fresh.promise);

			api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			api.drop();
			api.open();
			outage.resolve({ ref, turns: [previewAssistant("stale")] });
			await settle();

			expect(paneMode(controller.getView())).toBe("loading");

			fresh.resolve({ ref, turns });
			await settle();

			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.dispose();
		});

		// The realistic form: the read hangs, the stream drops and comes back
		// well inside its bound, and the bound then aborts it.
		it("does not hold on the timeout of a hung read the reconnect abandoned (OW-bilogo)", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				const turns = [previewAssistant("stored")];
				const controller = createController(api);
				await controller.start();
				api.open();
				await controller.select(ref);
				api.emit(snapshotOf(ref));
				await vi.advanceTimersByTimeAsync(0);
				api.preview.mockClear();
				// A read that settles only when it is aborted, as `fetch` does.
				api.preview.mockImplementationOnce((_session, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason));
					}));
				api.preview.mockResolvedValue({ ref, turns });

				api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
				await vi.advanceTimersByTimeAsync(2_000);
				api.drop();
				await vi.advanceTimersByTimeAsync(1_000);
				api.open();
				await vi.advanceTimersByTimeAsync(600_000);

				// `loadPreview`'s reads, which alone carry a signal: the preview's
				// own poll re-reads it through the 600s as well.
				expect(api.preview.mock.calls.filter(([, signal]) => signal !== undefined)).toHaveLength(2);
				expect(paneMode(controller.getView())).toBe("preview");
				expect(controller.getView().preview).toEqual({ ref, turns });
				expect(controller.getView().previewFailure).toBeNull();
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		// The server exits with the read out, and the read fails before the tab
		// hears the stream drop, so the stream still reads `connected`.
		it("keeps the selection for a preview read that fails before the drop is heard, and asks again at the next connected (OW-bilogo)", async () => {
			const api = new FakeApi();
			const turns = [previewAssistant("stored")];
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			await settle();
			api.preview.mockClear();
			api.preview.mockRejectedValueOnce(new TypeError("Failed to fetch"));
			api.preview.mockResolvedValue({ ref, turns });

			api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(api.preview).toHaveBeenCalledOnce();

			api.drop();
			await settle();
			expect(api.preview).toHaveBeenCalledOnce();
			api.open();
			await settle();

			expect(api.preview).toHaveBeenCalledTimes(2);
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// Stream up, the attach reply beats its snapshot (D2), and the preview
		// read the detached-loading pane asks meanwhile fails first.
		it("keeps an attach's selection when the preview read under its reply fails before the snapshot, and goes live at the snapshot (OW-bilogo)", async () => {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			api.open();
			await settle();
			api.preview.mockRejectedValue(new Error("preview failed"));

			await controller.select(ref);
			await settle();

			expect(api.preview).toHaveBeenCalledWith(ref, expect.any(AbortSignal));
			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");

			api.emit(snapshotOf(ref));

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("live");
			controller.dispose();
		});

		// A read that never settles would hold its key in `previewLoads` for
		// good, and nothing would ever ask for that session's preview again.
		it("aborts a preview read that has not settled within its bound, and asks again at the next connected (OW-bilogo)", async () => {
			vi.useFakeTimers();
			try {
				const api = new FakeApi();
				const turns = [previewAssistant("stored")];
				const controller = createController(api);
				await controller.start();
				api.open();
				await controller.select(ref);
				api.emit(snapshotOf(ref));
				await vi.advanceTimersByTimeAsync(0);
				api.preview.mockClear();
				const signals: Array<AbortSignal | undefined> = [];
				// A read that settles only when it is aborted, as `fetch` does.
				api.preview.mockImplementationOnce((_session, signal) => {
					signals.push(signal);
					return new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason));
					});
				});
				api.preview.mockResolvedValue({ ref, turns });

				api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
				await vi.advanceTimersByTimeAsync(9_999);
				expect(signals[0]?.aborted).toBe(false);
				await vi.advanceTimersByTimeAsync(1);

				expect(signals[0]?.aborted).toBe(true);
				expect(controller.getView().state.selected).toEqual(ref);
				expect(paneMode(controller.getView())).toBe("loading");
				expect(api.preview).toHaveBeenCalledOnce();

				api.drop();
				api.open();
				await vi.advanceTimersByTimeAsync(0);

				expect(api.preview).toHaveBeenCalledTimes(2);
				expect(paneMode(controller.getView())).toBe("preview");
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		// A server answering errors with the stream up: the failure branch never
		// asks again, and nor does any publish that merely finds the pane
		// loading -- a listing, a keystroke -- or the read would loop hot.
		it("asks no further preview after a failed read with the stream up until the row is selected again, showing the failure on the pane until a read succeeds (OW-bilogo)", async () => {
			const api = new FakeApi();
			const turns = [previewAssistant("stored")];
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			await settle();
			api.preview.mockClear();
			api.preview.mockRejectedValueOnce(new Error("preview failed"));

			api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			await settle();

			expect(controller.getView().previewFailure).toEqual({ ref, message: "preview failed" });
			expect(controller.getView().error).toBeNull();

			api.emit({ type: "sessions-changed" });
			controller.setDraft("unrelated");
			await settle();

			expect(api.preview).toHaveBeenCalledOnce();
			expect(paneMode(controller.getView())).toBe("loading");

			api.preview.mockResolvedValue({ ref, turns });
			await controller.preview(ref);
			await settle();

			expect(api.preview).toHaveBeenCalledTimes(2);
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// The stream is down, so the empty loading pane already says what is
		// going on; a line there would only repeat the outage.
		it("sets no failure line for a preview read that fails while the stream is down (OW-bilogo)", async () => {
			const api = new FakeApi();
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			await settle();
			const outage = deferred<SessionPreviewResponse>();
			api.preview.mockReturnValueOnce(outage.promise);

			api.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			api.drop();
			outage.reject(new TypeError("Failed to fetch"));
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// A drop leaves a session with a transcript on disk selected, and its
		// preview waits for a server that can answer it (D25 point 3).
		it("keeps a dropped selection detached-loading, and fetches its preview only once the stream is back (OW-forinu)", async () => {
			const api = new FakeApi();
			const turns = [previewAssistant("stored")];
			const controller = createController(api);
			await controller.start();
			api.open();
			await controller.select(ref);
			api.emit(snapshotOf(ref));
			await settle();
			api.preview.mockClear();
			api.preview.mockResolvedValue({ ref, turns });

			api.drop();
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(api.preview).not.toHaveBeenCalled();

			api.open();
			await settle();

			expect(api.preview).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal));
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.dispose();
		});
	});
});
