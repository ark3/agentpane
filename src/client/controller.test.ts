import { describe, expect, it, vi } from "vitest";
import type {
	ForkAndPromptResponse,
	ForkPointsResponse,
	LiveSessionSummary,
	ModelInfo,
	PromptResponse,
	ServerEvent,
	SessionPreviewResponse,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
import { ApiClientError } from "./api.ts";
import { createController, paneMode, type AgentpaneController } from "./controller.ts";
import { sessionKey } from "$shared/protocol.ts";
import { liveSummary, serverHandle, socketServer, type Script, type SnapshotEvent, type SocketServer } from "./test-support.ts";

const ref: SessionRef = { backend: "pi", id: "virtual-a" };
const attachedRef: SessionRef = { backend: "pi", id: "/sessions/a.jsonl" };
/** A Codex-shaped fork: a brand-new thread this client is not driving yet. */
const forkedRef: SessionRef = { backend: "codex", id: "thread-forked" };

/** The handle the server minted for the session a ref names, opaque here (D24). */
function h(session: SessionRef): string {
	return serverHandle(session);
}

function summary(session: SessionRef, cwd = "/work", handle = h(session)): LiveSessionSummary {
	return liveSummary(session, { cwd, handle });
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
 * the only thing that makes its pane live (OW-forinu): an attach's reply
 * moves the selection and writes no view (`selectAttached`).
 */
function snapshotOf(session: SessionRef, handle = h(session)): SnapshotEvent {
	return { type: "snapshot", session, handle, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] };
}

/** What `sessions/preview` refuses with for a ref nobody holds and no file backs (D26 point 5). */
function gone(): ApiClientError {
	return new ApiClientError("gone", "no such session");
}

/** Open the socket again at once, as a pasted token does, and let its `hello` be answered. */
async function reopen(controller: AgentpaneController): Promise<void> {
	controller.reconnect();
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** An attach or a create held until the test lets it land on a ref: it writes that session's snapshot, then replies (D31 point 3). */
function lands(server: SocketServer, held: Promise<SessionRef>): Promise<{ session: LiveSessionSummary }> {
	return held.then((landed) => ({ session: server.attached(landed) }));
}

/**
 * The next attach, or create, leaves `snapshot`'s session live with it: it
 * writes `snapshot`, then replies (D31 point 3).
 */
function attachesWith(
	server: SocketServer,
	snapshot: SnapshotEvent,
	command: "sessions/attach" | "sessions/create" = "sessions/attach",
	reply: Partial<LiveSessionSummary> = {},
): void {
	server.on[command].mockImplementationOnce(() => ({ session: server.attached(snapshot.session, snapshot, { ...reply, handle: snapshot.handle }) }));
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

/**
 * The scripted server these tests drive the real api over (D31), answering
 * as `socketServer` does but for what this file's fixtures name: the
 * listing holds `ref`, a create attaches `ref`, a fork lands on `forkedRef`.
 */
function fakeServer(script: Script = {}): SocketServer {
	return socketServer({
		"sessions/list": () => ({ sessions: [summary(ref)] }),
		"sessions/create": (_params, server) => ({ session: server.attached(ref) }),
		"draft/edit": () => ({ text: "edited draft" }),
		"sessions/fork": () => ({ ref: forkedRef }),
		"sessions/forkAndPrompt": (_params, server) => ({ session: server.attached(forkedRef), disposition: "started" }),
		...script,
	});
}

describe("client controller", () => {
	it("lists models when a snapshot makes the session whose preview is on screen live", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.preview(ref);
		expect(server.on["models/list"]).not.toHaveBeenCalled();

		// Another client attaches it: the snapshot is the first this tab hears.
		server.attached(ref, { model: "opaque/current" });
		await Promise.resolve();

		expect(server.on["models/list"]).toHaveBeenCalledExactlyOnceWith({ backend: "pi" });
	});

	it("does not let an older A list overwrite a newer A list after A to B to A selection", async () => {
		const server = fakeServer();
		const oldA = deferred<ModelInfo[]>();
		const newA = deferred<ModelInfo[]>();
		server.on["models/list"].mockReturnValueOnce(oldA.promise.then((models) => ({ models }))).mockReturnValueOnce(newA.promise.then((models) => ({ models })));
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [{ role: "user", content: "done", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		const server = fakeServer();
		const oldA = deferred<ModelInfo[]>();
		const newA = deferred<ModelInfo[]>();
		server.on["models/list"].mockReturnValueOnce(oldA.promise.then((models) => ({ models }))).mockReturnValueOnce(newA.promise.then((models) => ({ models })));
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [{ role: "user", content: "done", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

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
		const server = fakeServer();
		const setting = deferred<void>();
		server.on["sessions/setModel"].mockReturnValue(setting.promise);
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
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
		const server = fakeServer();
		const setting = deferred<void>();
		server.on["sessions/setModel"].mockReturnValue(setting.promise);
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/b", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);

		const first = controller.setModel("opaque/next");
		await controller.preview(attachedRef);
		await controller.preview(ref);
		expect(controller.getView().modelSetting).toBe(true);

		const second = controller.setModel("opaque/later");
		expect(server.on["sessions/setModel"]).toHaveBeenCalledOnce();
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
		const server = fakeServer();
		const setting = deferred<void>();
		server.on["sessions/setModel"].mockReturnValueOnce(setting.promise);
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);

		const first = controller.setModel("opaque/next");
		const renamed: SessionRef = { backend: "pi", id: "/sessions/real-a.jsonl" };
		server.emit({ type: "status", session: renamed, handle: h(ref), seq: 2, isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null });
		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().modelSetting).toBe(true);

		await controller.setModel("opaque/later");
		expect(server.on["sessions/setModel"]).toHaveBeenCalledOnce();
		setting.reject(new Error("renamed A set failed"));
		await first;

		expect(controller.getView().error).toBe("renamed A set failed");
		expect(controller.getView().modelSetting).toBe(false);
	});

	it("lists only for an empty selection and leaves model truth to server status", async () => {
		const server = fakeServer();
		server.on["models/list"].mockResolvedValue({ models: [{ id: "opaque/next", label: "Next", efforts: [], defaultEffort: null }] });
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		await controller.preview(ref);
		expect(server.on["models/list"]).toHaveBeenCalledWith({ backend: ref.backend });
		await controller.setModel("opaque/next");
		expect(server.on["sessions/setModel"]).toHaveBeenCalledWith({ handle: h(ref), model: "opaque/next" });
		expect(controller.getView().state.sessions[h(ref)]?.model).toBe("opaque/current");

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 2, isStreaming: false, compaction: null, model: "opaque/next", effort: null, unrestoredModel: null });
		expect(controller.getView().state.sessions[h(ref)]?.model).toBe("opaque/next");
	});

	it("never lists models when selecting a conversation that already has messages", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		await controller.preview(ref);

		expect(server.on["models/list"]).not.toHaveBeenCalled();
	});

	it("never sets a model once the conversation has a message", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);

		await controller.setModel("opaque/next");

		expect(server.on["sessions/setModel"]).not.toHaveBeenCalled();
		expect(controller.getView().modelSetting).toBe(false);
	});

	it("disables only model selection while setting and does not block the first prompt", async () => {
		const server = fakeServer();
		const setting = deferred<void>();
		server.on["sessions/setModel"].mockReturnValue(setting.promise);
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);
		controller.setDraft("send while setting");

		const selecting = controller.setModel("opaque/next");
		expect(controller.getView()).toMatchObject({ busy: "idle", modelSetting: true });
		await controller.submit();
		expect(server.on["sessions/prompt"]).toHaveBeenCalledWith({ text: "send while setting", priorErrorId: null, handle: h(ref) });
		setting.resolve();
		await selecting;
	});

	it("sets an exact effort under its own pending flag, not the model's", async () => {
		const server = fakeServer();
		const setting = deferred<void>();
		server.on["sessions/setEffort"].mockReturnValue(setting.promise);
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/current", effort: "medium", unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);

		const choosing = controller.setEffort("high");
		expect(server.on["sessions/setEffort"]).toHaveBeenCalledWith({ handle: h(ref), effort: "high" });
		expect(controller.getView()).toMatchObject({ effortSetting: true, modelSetting: false });
		await controller.setEffort("low");
		expect(server.on["sessions/setEffort"]).toHaveBeenCalledOnce();
		setting.resolve();
		await choosing;

		expect(controller.getView().effortSetting).toBe(false);
		expect(controller.getView().state.sessions[h(ref)]?.effort).toBe("medium");
	});

	it("never sets an effort once the conversation has a message", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [{ role: "user", content: "already sent", timestamp: 1 }], isStreaming: false, compaction: null, model: "opaque/current", effort: "medium", unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);

		await controller.setEffort("high");

		expect(server.on["sessions/setEffort"]).not.toHaveBeenCalled();
		expect(controller.getView().effortSetting).toBe(false);
	});

	it("connects the socket and loads summaries when started", async () => {
		const server = fakeServer();
		const controller = createController(server.api());

		await controller.start();

		expect(server.sockets).toHaveLength(1);
		expect(server.on["sessions/list"]).toHaveBeenCalledWith({});
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
	});

	it("creates with one request, which attaches, and selects the authoritative response ref without prompting (D30)", async () => {
		const server = fakeServer();
		server.on["sessions/create"].mockImplementation(() => ({ session: server.attached(attachedRef) }));
		const controller = createController(server.api());
		await controller.start();

		await controller.create("/work", "pi");

		expect(server.on["sessions/create"]).toHaveBeenCalledWith({ cwd: "/work", backend: "pi" });
		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
	});

	it("selects the authoritative ref returned by attach", async () => {
		const server = fakeServer();
		server.on["sessions/attach"].mockImplementation(() => ({ session: server.attached(attachedRef) }));
		const controller = createController(server.api());
		await controller.start();

		await controller.select(ref);

		expect(server.on["sessions/attach"]).toHaveBeenCalledWith({ ref: ref });
		expect(controller.getView().state.selected).toEqual(attachedRef);
		// The reply writes no row (D28): the startup listing's stands until the
		// listing the attach's `sessions-changed` asks.
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
	});

	it("previews a stored session read-only, selecting it without attaching or spawning", async () => {
		const server = fakeServer();
		server.on["sessions/preview"].mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
		const controller = createController(server.api());
		await controller.start();

		await controller.preview(ref);

		expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: ref });
		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(controller.getView().preview).toEqual({ ref, turns: [{ role: "user", content: "hi" }] });
		expect(controller.getView().state.selected).toEqual(ref);
	});

	it("reselects an already-attached session live instead of re-fetching a stale preview", async () => {
		const server = fakeServer();
		server.on["sessions/attach"].mockImplementation(() => ({ session: server.attached(attachedRef) }));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		expect(controller.getView().state.selected).toEqual(attachedRef);
		server.on["sessions/preview"].mockClear();

		await controller.preview(attachedRef);

		expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().preview).toBeNull();
	});

	it("clears the read-only preview once the session is attached", async () => {
		const server = fakeServer();
		server.on["sessions/preview"].mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
		server.on["sessions/attach"].mockImplementation(() => ({ session: server.attached(attachedRef) }));
		const controller = createController(server.api());
		await controller.start();

		await controller.preview(ref);
		expect(controller.getView().preview).not.toBeNull();

		await controller.select(ref);

		expect(server.on["sessions/attach"]).toHaveBeenCalledWith({ ref: ref });
		expect(controller.getView().preview).toBeNull();
		expect(controller.getView().state.selected).toEqual(attachedRef);
	});

	it("keeps the latest selection when earlier and later attaches resolve out of order", async () => {
		const server = fakeServer();
		const firstRef: SessionRef = { backend: "pi", id: "/sessions/first.jsonl" };
		const secondRef: SessionRef = { backend: "codex", id: "thread-second" };
		const first = deferred<SessionRef>();
		const second = deferred<SessionRef>();
		server.on["sessions/attach"].mockImplementation(({ ref: asked }) => {
			if (asked.id === firstRef.id) return lands(server, first.promise);
			if (asked.id === secondRef.id) return lands(server, second.promise);
			throw new Error(`unexpected ref ${asked.id}`);
		});
		const controller = createController(server.api());
		await controller.start();

		const selectingFirst = controller.select(firstRef);
		const selectingSecond = controller.select(secondRef);
		second.resolve(secondRef);
		await selectingSecond;
		expect(controller.getView().state.selected).toEqual(secondRef);

		first.resolve(firstRef);
		await selectingFirst;

		expect(controller.getView().state.selected).toEqual(secondRef);
		// No listing has named either, and an attach reply writes no row (D28):
		// the listing that follows each attach is what brings it.
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
	});

	it("ignores a stale create response after a newer selection completes", async () => {
		const server = fakeServer();
		const createdRef: SessionRef = { backend: "pi", id: "virtual-created" };
		const selectedRef: SessionRef = { backend: "codex", id: "thread-selected" };
		const created = deferred<SessionRef>();
		server.on["sessions/create"].mockReturnValue(lands(server, created.promise));
		const controller = createController(server.api());
		await controller.start();

		const creating = controller.create("/work", "pi");
		await controller.select(selectedRef);
		expect(controller.getView().state.selected).toEqual(selectedRef);
		expect(controller.getView().busy).toBe("idle");

		created.resolve(createdRef);
		await creating;

		expect(server.on["sessions/attach"]).toHaveBeenCalledTimes(1);
		expect(server.on["sessions/attach"]).toHaveBeenCalledWith({ ref: selectedRef });
		expect(controller.getView().state.selected).toEqual(selectedRef);
		expect(controller.getView().busy).toBe("idle");
	});

	/**
	 * A preview is a new selection, so it ends the claim of the attach it
	 * supersedes and the `"attaching"` that claim published with it: left
	 * standing, the status line read "Opening session…" and the external editor
	 * refused until some later action reset `busy` (OW-nizemu).
	 */
	it("returns busy to idle when a preview supersedes an attach still in flight (OW-nizemu)", async () => {
		const server = fakeServer();
		const storedRef: SessionRef = { backend: "codex", id: "thread-stored" };
		const attaching = deferred<SessionRef>();
		server.on["sessions/attach"].mockReturnValueOnce(lands(server, attaching.promise));
		const controller = createController(server.api());
		await controller.start();

		const selecting = controller.select(attachedRef);
		await controller.preview(storedRef);
		attaching.resolve(attachedRef);
		await selecting;

		expect(controller.getView().state.selected).toEqual(storedRef);
		expect(controller.getView().busy).toBe("idle");
		controller.setDraft("current draft");
		await controller.editDraft();
		expect(server.on["draft/edit"]).toHaveBeenCalledWith({ text: "current draft" });
	});

	/** The same through `preview`'s other path, the reselect of a session live here (OW-nizemu). */
	it("returns busy to idle when reselecting a live session supersedes an attach still in flight (OW-nizemu)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		const attaching = deferred<SessionRef>();
		server.on["sessions/attach"].mockReturnValueOnce(lands(server, attaching.promise));

		const selecting = controller.select(attachedRef);
		await controller.preview(ref);
		attaching.resolve(attachedRef);
		await selecting;

		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().busy).toBe("idle");
		controller.setDraft("current draft");
		await controller.editDraft();
		expect(server.on["draft/edit"]).toHaveBeenCalledWith({ text: "current draft" });
	});

	/**
	 * The clear rides the superseding gesture's own publish rather than one of
	 * its own ahead of it: a publish while the pane is loading asks
	 * `loadPreview`'s read, and one between the bump and `preview` making its
	 * read the click's asked one for the row being left, under the click's
	 * intent, whose `gone` cleared the selection (OW-nizemu).
	 */
	it("asks no read of the loading row a preview leaves when it supersedes an attach (OW-nizemu)", async () => {
		const server = fakeServer();
		const previewedRef: SessionRef = { backend: "codex", id: "thread-previewed" };
		const leftRead = deferred<SessionPreviewResponse>();
		const previewing = deferred<SessionPreviewResponse>();
		let leftReads = 0;
		server.on["sessions/preview"].mockImplementation(async ({ ref: session }) => {
			if (session.id === previewedRef.id) return previewing.promise;
			leftReads += 1;
			if (leftReads === 1) return leftRead.promise;
			throw gone();
		});
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		await settle();
		// A gap leaves the row detached-loading, with its read out.
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		const attaching = deferred<SessionRef>();
		server.on["sessions/attach"].mockReturnValueOnce(lands(server, attaching.promise));
		const selecting = controller.select(attachedRef);
		// The read fails once the attach owns the intent, so it lands nowhere.
		leftRead.reject(new Error("offline"));
		await settle();

		const previewingClick = controller.preview(previewedRef);
		await settle();

		expect(server.on["sessions/preview"].mock.calls.map(([params]) => params.ref.id)).toEqual([ref.id, previewedRef.id]);
		expect(controller.getView().state.selected).toEqual(ref);
		previewing.resolve({ ref: previewedRef, turns: [] });
		await previewingClick;
		expect(controller.getView().state.selected).toEqual(previewedRef);
		expect(controller.getView().busy).toBe("idle");
		attaching.resolve(attachedRef);
		await selecting;
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	/** The newer attach's own `"attaching"` survives the clear its bump makes (OW-nizemu). */
	it("keeps busy on the newer attach's \"attaching\" until it replies when one select supersedes another (OW-nizemu)", async () => {
		const server = fakeServer();
		const firstRef: SessionRef = { backend: "pi", id: "/sessions/first.jsonl" };
		const secondRef: SessionRef = { backend: "codex", id: "thread-second" };
		const first = deferred<SessionRef>();
		const second = deferred<SessionRef>();
		server.on["sessions/attach"].mockImplementation(({ ref: asked }) => lands(server, asked.id === firstRef.id ? first.promise : second.promise));
		const controller = createController(server.api());
		await controller.start();

		const selectingFirst = controller.select(firstRef);
		const selectingSecond = controller.select(secondRef);
		expect(controller.getView().busy).toBe("attaching");
		first.resolve(firstRef);
		await selectingFirst;
		expect(controller.getView().busy).toBe("attaching");
		second.resolve(secondRef);
		await selectingSecond;
		expect(controller.getView().busy).toBe("idle");
	});

	it("keeps the draft when prompt submission fails", async () => {
		const server = fakeServer();
		server.on["sessions/prompt"].mockRejectedValue(new Error("offline"));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("keep me");

		await controller.submit();

		expect(controller.getView().draft).toBe("keep me");
		expect(controller.getView().error).toBe("offline");
	});

	it("replaces the current draft with the external editor result", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		controller.setDraft("current draft");

		await controller.editDraft();

		expect(server.on["draft/edit"]).toHaveBeenCalledWith({ text: "current draft" });
		expect(controller.getView()).toMatchObject({ draft: "edited draft", busy: "idle", error: null });
	});

	it("surfaces an external editor failure and gates re-entry while it is open", async () => {
		const server = fakeServer();
		const editing = deferred<{ text: string }>();
		server.on["draft/edit"].mockReturnValue(editing.promise);
		const controller = createController(server.api());
		await controller.start();
		controller.setDraft("keep me");

		const first = controller.editDraft();
		const second = controller.editDraft();
		expect(controller.getView().busy).toBe("editing-externally");
		expect(server.on["draft/edit"]).toHaveBeenCalledTimes(1);
		editing.reject(new Error("editor exited 1"));
		await Promise.all([first, second]);

		expect(controller.getView()).toMatchObject({ draft: "keep me", busy: "idle", error: "editor exited 1" });
	});

	/**
	 * The textarea stays live while the editor is open, so the composer can
	 * move under it; what moved in is kept beside the editor's text, ahead of
	 * it as `withQueued` puts arrivals (OW-momejo).
	 */
	it("keeps text that reached the composer while the external editor was open", async () => {
		const server = fakeServer();
		const editing = deferred<{ text: string }>();
		server.on["draft/edit"].mockReturnValue(editing.promise);
		const controller = createController(server.api());
		await controller.start();
		controller.setDraft("current draft");

		const edit = controller.editDraft();
		controller.setDraft("typed meanwhile");
		editing.resolve({ text: "edited draft" });
		await edit;

		expect(controller.getView().draft).toBe("typed meanwhile\n\nedited draft");
	});

	/**
	 * Text that joined ahead of the sent draft, as a stop's released prompts do,
	 * keeps its place, and the editor's text stands in for the draft it was
	 * given rather than beside it (OW-momejo).
	 */
	it("puts the external editor's text in place of the draft it was given when text joined ahead of it", async () => {
		const server = fakeServer();
		const editing = deferred<{ text: string }>();
		server.on["draft/edit"].mockReturnValue(editing.promise);
		const controller = createController(server.api());
		await controller.start();
		controller.setDraft("current draft");

		const edit = controller.editDraft();
		controller.setDraft("first steer\n\ncurrent draft");
		editing.resolve({ text: "edited draft" });
		await edit;

		expect(controller.getView().draft).toBe("first steer\n\nedited draft");
	});

	/**
	 * The editor and a send hold the draft exclusively of each other: a send
	 * started mid-trip would leave its own text under Send once the answer
	 * kept it (OW-momejo).
	 */
	it("sends nothing and forks nothing while the external editor is open", async () => {
		const server = fakeServer();
		const editing = deferred<{ text: string }>();
		server.on["draft/edit"].mockReturnValue(editing.promise);
		server.on["sessions/forkPoints"].mockResolvedValue({ points: [{ id: "turn-1", text: "first", index: 0 }], forkStopsTurn: false });
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("current draft");

		const edit = controller.editDraft();
		expect(await controller.submit()).toBeNull();
		expect(await controller.forkAndSubmit(0)).toBeNull();

		expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
		expect(server.on["sessions/abort"]).not.toHaveBeenCalled();
		expect(server.on["sessions/forkAndPrompt"]).not.toHaveBeenCalled();
		expect(controller.getView().sending).toBe(false);
		editing.resolve({ text: "edited draft" });
		await edit;
	});

	/**
	 * An abort writes `busy` over the round trip's, so `busy` cannot be what
	 * keeps a second editor from opening (OW-momejo).
	 */
	it("opens no second external editor when an abort lands during the round trip", async () => {
		const server = fakeServer();
		const editing = deferred<{ text: string }>();
		server.on["draft/edit"].mockReturnValue(editing.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("current draft");

		const edit = controller.editDraft();
		await controller.abort();
		const second = controller.editDraft();

		expect(server.on["draft/edit"]).toHaveBeenCalledTimes(1);
		expect(controller.getView().editingExternally).toBe(true);
		editing.resolve({ text: "edited draft" });
		await Promise.all([edit, second]);
		expect(controller.getView()).toMatchObject({ draft: "edited draft", editingExternally: false, busy: "idle" });
	});

	it("clears the draft only after the prompt is accepted", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("send me");

		await controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledWith({ text: "send me", priorErrorId: null, handle: h(ref) });
		expect(controller.getView().draft).toBe("");
	});

	/**
	 * The browser draws no composer on a detached session, so a prompt always
	 * names the handle its view holds (D30): one whose handle a close ended,
	 * the session attached again elsewhere, is refused rather than going to a
	 * session this tab does not show.
	 */
	it("names the handle of the live view it was sent from (D30)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, snapshotOf(ref, "handle-again"));
		await controller.select(ref);
		controller.setDraft("send me");

		await controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledWith({ text: "send me", priorErrorId: null, handle: "handle-again" });
	});

	/**
	 * The shell takes its follow and badge arming down for a prompt that
	 * started no turn, and only the answer here can tell it which one this was
	 * (OW-yobayi). The draft clears either way: the backend took the prompt.
	 */
	it("resolves a landed prompt's disposition, handled for a reply saying so and started for none (OW-yobayi)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);

		controller.setDraft("/mcp");
		server.on["sessions/prompt"].mockResolvedValueOnce({ disposition: "handled" });
		expect(await controller.submit()).toBe("handled");
		expect(controller.getView().draft).toBe("");

		controller.setDraft("a real prompt");
		expect(await controller.submit()).toBe("started");
	});

	it("ignores a second submit while the first prompt is still in flight", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("send me once");

		const first = controller.submit();
		const second = controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledOnce();
		prompt.resolve({ disposition: "started" });
		await Promise.all([first, second]);
		expect(controller.getView()).toMatchObject({ draft: "", busy: "idle" });
	});

	it("keeps the view error through a broadcast-driven re-list (OW-dinuwu)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.submit();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");

		server.emit({ type: "sessions-changed" });
		await settle();

		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");
		controller.dispose();
	});

	it("leaves busy at submitting across a broadcast-driven re-list (OW-dinuwu)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const submitted = controller.submit();

		server.emit({ type: "sessions-changed" });
		await settle();

		expect(controller.getView().busy).toBe("submitting");
		prompt.resolve({ disposition: "started" });
		await submitted;
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// The server broadcasts `sessions-changed` at every turn boundary (OW-furinu),
	// so one lands inside every prompt's round trip -- and the re-list it triggers
	// used to clear `busy` under the guard above and let the second press through
	// (OW-dinuwu).
	it("ignores a second submit after the in-flight prompt's own re-list (OW-dinuwu)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const first = controller.submit();

		server.emit({ type: "sessions-changed" });
		await settle();
		const second = controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledOnce();
		prompt.resolve({ disposition: "started" });
		await Promise.all([first, second]);
		controller.dispose();
	});

	it("surfaces a failure to a Refresh that joined a broadcast-driven re-list (OW-dinuwu)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		const listed = deferred<SessionSummary[]>();
		server.on["sessions/list"].mockReturnValueOnce(listed.promise.then((sessions) => ({ sessions }))).mockRejectedValueOnce(new Error("list is down"));
		server.emit({ type: "sessions-changed" });

		// The press waits on the listing owed after the silent one (OW-sabova)
		// rather than starting its own, so this is the only thing that can report
		// that listing's failure to the user. The silent one's stays silent.
		const errors: (string | null)[] = [];
		controller.subscribe((next) => errors.push(next.error));
		const pressed = controller.refreshSessions();
		listed.reject(new Error("silent listing failed"));
		await pressed;

		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(3);
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
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			const listed = deferred<SessionSummary[]>();
			const owed = deferred<SessionSummary[]>();
			server.on["sessions/list"].mockReturnValueOnce(listed.promise.then((sessions) => ({ sessions }))).mockReturnValueOnce(owed.promise.then((sessions) => ({ sessions })));
			const attached = deferred<SessionRef>();
			server.on["sessions/attach"].mockReturnValueOnce(lands(server, attached.promise));
			server.emit({ type: "sessions-changed" });

			const pressed = controller.refreshSessions();
			const selecting = controller.select(ref);
			if (attach === "failed") {
				attached.reject(new Error("attach failed"));
				await selecting;
			}
			listed.resolve([summary(ref)]);
			await settle();

			expect(server.on["sessions/list"]).toHaveBeenCalledTimes(3);
			expect(controller.getView()).toMatchObject(
				attach === "pending" ? { busy: "attaching" } : { busy: "idle", error: "attach failed" },
			);
			if (attach === "pending") {
				attached.resolve(ref);
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
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("send me");

		const submitted = controller.submit();
		controller.setDraft("the next thing I want to say");
		prompt.resolve({ disposition: "started" });
		await submitted;

		expect(server.on["sessions/prompt"]).toHaveBeenCalledWith({ text: "send me", priorErrorId: null, handle: h(ref) });
		expect(controller.getView().draft).toBe("the next thing I want to say");
	});

	it("aborts the current authoritative selected ref", async () => {
		const server = fakeServer();
		server.on["sessions/attach"].mockImplementation(() => ({ session: server.attached(attachedRef) }));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);

		await controller.abort();

		expect(server.on["sessions/abort"]).toHaveBeenCalledWith({ handle: h(attachedRef) });
	});

	/**
	 * The words come back to the caller and nowhere else: where they belong
	 * depends on what the composer holds when the answer lands, which only the
	 * shell knows (OW-fahoti).
	 */
	it("resolves with the prompts a stop took out of Pi's queue, in order, and leaves the draft alone (OW-fahoti)", async () => {
		const server = fakeServer();
		server.on["sessions/abort"].mockResolvedValueOnce({ queued: ["first steer", "second steer"] });
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("half-written note");

		expect(await controller.abort()).toEqual(["first steer", "second steer"]);
		expect(controller.getView().draft).toBe("half-written note");
	});

	it("resolves with no prompts when a stop took nothing out (OW-fahoti)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);

		expect(await controller.abort()).toEqual([]);
	});

	// D25 point 5: a gap detaches the session in this tab, and nothing attaches
	// it on the client's behalf -- an attach is what spawns, and the user clicking
	// the row is the deliberate one. However many events gap, none attaches.
	it("detaches a selected session whose sequence gaps and lands on its preview, without attaching it (OW-lunihe)", async () => {
		const server = fakeServer();
		server.on["sessions/abort"].mockRejectedValueOnce(new Error("abort failed"));
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		await settle();
		await controller.abort();
		server.on["sessions/attach"].mockClear();

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 4, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).toBe("preview");
		expect(controller.getView().preview).toEqual({ ref, turns: [] });
		// Not a gesture, so it empties no mail the user has not read.
		expect(controller.getView().error).toBe("abort failed");
		controller.dispose();
	});

	// A gap ends the badge's watch on its session, raising nothing (OW-jadoda),
	// so only a gap tells the gap listeners: an `ended` tells no one, and the
	// socket's close tells the close listeners, whose `watchClose` ends every
	// watch (D31 point 6).
	it("tells the gap listeners the handle a gap detached, and only a gap", async () => {
		const other: SessionRef = { backend: "codex", id: "codex-2" };
		const server = fakeServer();
		const controller = createController(server.api());
		const gapped: string[] = [];
		controller.subscribeGaps((handle) => gapped.push(handle));
		await controller.start();
		const snapshot = (session: SessionRef): ServerEvent => ({ type: "snapshot", session, handle: h(session), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit(snapshot(ref));
		server.emit(snapshot(other));

		server.emit({ type: "ended", session: other, handle: h(other) });
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		expect(gapped).toEqual([h(ref)]);

		server.emit(snapshot(ref));
		server.drop();
		expect(controller.getView().state.sessions).toEqual({});
		expect(gapped).toEqual([h(ref)]);
		controller.dispose();
	});

	// The server still holds the session, so its preview answers an empty
	// transcript rather than `gone` (D26 point 5): the empty preview's Attach
	// reaches it and the poll finds the first turn's file.
	it("lands a gapped selection with nothing on disk on its preview (OW-lunihe)", async () => {
		const server = fakeServer();
		server.on["sessions/attach"].mockImplementationOnce(() => ({ session: server.attached(ref, { seq: 1 }, { onDisk: false }) }));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		await settle();
		server.on["sessions/attach"].mockClear();
		server.on["sessions/preview"].mockClear();

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: ref });
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().preview).toEqual({ ref, turns: [] });
		controller.dispose();
	});

	// The reducer returns on a gap before it moves anything, so the selection
	// still names the old ref; the gapped event's is the session's current one.
	it("previews the ref a gapped event renamed the session to (OW-lunihe)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		await settle();
		server.on["sessions/preview"].mockClear();
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };

		server.emit({ type: "status", session: renamed, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: renamed });
		expect(server.on["sessions/preview"].mock.calls.map(([params]) => params.ref)).not.toContainEqual(ref);
		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().preview).toEqual({ ref: renamed, turns: [] });
		controller.dispose();
	});

	// A failed read is never an answer (OW-bilogo): the selection stands, and
	// the failure is the pane's to show.
	it("keeps a gapped selection detached-loading when its preview cannot be read, reporting it on the pane (OW-lunihe, OW-bilogo)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		await settle();
		server.on["sessions/preview"].mockRejectedValueOnce(new Error("preview failed"));

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
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
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		await settle();
		const previewing = deferred<SessionPreviewResponse>();
		server.on["sessions/preview"].mockReturnValueOnce(previewing.promise);
		const attaching = deferred<SessionRef>();
		server.on["sessions/attach"].mockReturnValueOnce(lands(server, attaching.promise));

		const selecting = controller.select(attachedRef);
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		attaching.resolve(attachedRef);
		await selecting;
		previewing.resolve({ ref, turns: [] });
		await settle();

		expect(controller.getView().state.selected).toEqual(attachedRef);
		// The click's own row is live, and the gap's preview never replaced it.
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().preview).toBeNull();
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// Another client's attach snapshots the session to every client, which
	// brings its live view back here while the gap's preview is out.
	it("keeps a gapped session live when a snapshot re-introduces it before its preview lands (OW-lunihe)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		await settle();
		const previewing = deferred<SessionPreviewResponse>();
		server.on["sessions/preview"].mockReturnValueOnce(previewing.promise);

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		previewing.resolve({ ref, turns: [] });
		await settle();

		expect(controller.getView().state.sessions[h(ref)]).toBeDefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	// The gap's preview can resolve while the attach made meanwhile is out,
	// when the selection names the session and no view is back yet. It lands
	// then, and the attach's snapshot outranks it (`paneMode`).
	it("goes live over the gap's preview once the attach of the same session made while it was out brings its snapshot (OW-lunihe, OW-forinu)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		await settle();
		server.on["sessions/preview"].mockClear();
		const previewing = deferred<SessionPreviewResponse>();
		server.on["sessions/preview"].mockReturnValueOnce(previewing.promise);
		const attaching = deferred<SessionRef>();
		server.on["sessions/attach"].mockReturnValueOnce(lands(server, attaching.promise));

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		const selecting = controller.select(ref);
		previewing.resolve({ ref, turns: [] });
		await settle();

		// The attach is out, and until its snapshot the pane is not live,
		// whatever it shows: one read, the gap's, served both.
		expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(paneMode(controller.getView())).not.toBe("live");

		attaching.resolve(ref);
		await selecting;
		expect(controller.getView().state.sessions[h(ref)]).toBeDefined();
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	it("keeps the error slot through a sequence gap (OW-yasewo)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.submit();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");

		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().error).toBe("Select a session before submitting a prompt.");
		controller.dispose();
	});

	// `busy` is one global slot and a gap is per-session, so a gap on B must not
	// write over the prompt the user is watching in A, nor move the selection
	// off it; re-attaching B used to write "Opening session…" there.
	it("leaves busy at submitting and the selection in place across another session's sequence gap (OW-yasewo)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const submitted = controller.submit();

		server.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "status", session: attachedRef, handle: h(attachedRef), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(controller.getView().state.sessions[h(attachedRef)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().busy).toBe("submitting");
		prompt.resolve({ disposition: "started" });
		await submitted;
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	// A regression guard, not a red-first test: since OW-kelede the send guard
	// reads `sending`, which a gap does not touch. Nothing else pins a gap
	// against that guard, and the guard has moved once already.
	it("ignores a second submit while another session's sequence gaps (OW-yasewo)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const first = controller.submit();

		server.emit({ type: "snapshot", session: attachedRef, handle: h(attachedRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		server.emit({ type: "status", session: attachedRef, handle: h(attachedRef), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();
		const second = controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledOnce();
		prompt.resolve({ disposition: "started" });
		await Promise.all([first, second]);
		controller.dispose();
	});

	it("does not select a session whose sequence gaps, nor touch the preview on screen", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();
		expect(controller.getView().state.selected).toBeNull();
		expect(controller.getView().preview).toBeNull();

		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(attachedRef);
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
		controller.dispose();
	});

	// A broadcast that joins a listing already out is owed a fresh one, since the
	// answer it joined may predate the change it announces -- but a burst of them
	// owes exactly one, however long it is (OW-sabova).
	it("coalesces a burst of session-list refreshes into one owed listing", async () => {
		const server = fakeServer();
		const listed = deferred<SessionSummary[]>();
		const owed = deferred<SessionSummary[]>();
		const controller = createController(server.api());
		await controller.start();
		server.on["sessions/list"].mockClear();
		server.on["sessions/list"].mockReturnValueOnce(listed.promise.then((sessions) => ({ sessions }))).mockReturnValueOnce(owed.promise.then((sessions) => ({ sessions })));

		server.emit({ type: "sessions-changed" });
		server.emit({ type: "sessions-changed" });
		server.emit({ type: "sessions-changed" });
		server.emit({ type: "sessions-changed" });

		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(1);
		listed.resolve([summary(attachedRef)]);
		await settle();
		expect(controller.getView().state.summaries).toEqual([summary(attachedRef)]);
		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(2);

		owed.resolve([summary(ref)]);
		await settle();
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	// The attach reply leaves the row's `status` to the listing (OW-wazija), and
	// the attach's own broadcast is what brings that listing. When a listing is
	// already out as the user attaches, the broadcast joins it, and its answer --
	// given before the attach -- says `detached`; the current row carries that
	// too, so only a listing asked after this one can light the row (OW-sabova).
	it("lights the row of a session attached while a listing was in flight (OW-sabova)", async () => {
		const server = fakeServer();
		const detached = { ...summary(ref), status: "detached" as const };
		server.on["sessions/list"].mockResolvedValueOnce({ sessions: [detached] });
		const controller = createController(server.api());
		await controller.start();
		await settle();
		server.on["sessions/list"].mockClear();
		const listed = deferred<SessionSummary[]>();
		server.on["sessions/list"].mockReturnValueOnce(listed.promise.then((sessions) => ({ sessions })));
		server.emit({ type: "sessions-changed" });
		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(1);

		await controller.select(ref);
		server.emit({ type: "sessions-changed" });
		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(1);
		listed.resolve([detached]);
		await settle();

		expect(server.on["sessions/list"]).toHaveBeenCalledTimes(2);
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		controller.dispose();
	});

	// The server writes the `ended` and the `sessions-changed` before it
	// answers the close (D31 point 3), and the view goes on the `ended` (D26),
	// so by the time the close answers the pane reads the preview.
	it("detaches the selected session onto its read-only preview, its ended landing before the close answers", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		const detachedSummary = { ...summary(ref), status: "detached" as const, isStreaming: false };
		server.on["sessions/list"].mockResolvedValue({ sessions: [detachedSummary] });
		const turns: SessionPreviewTurn[] = [{ role: "user", content: "done" }];
		server.on["sessions/preview"].mockResolvedValue({ ref, turns });

		await controller.detach();
		await settle();
		expect(server.on["sessions/close"]).toHaveBeenCalledWith({ ref: ref });

		const detachedView = controller.getView();
		expect(detachedView.state.sessions[h(ref)]).toBeUndefined();
		expect(detachedView.state.selected).toEqual(ref);
		expect(paneMode(detachedView)).toBe("preview");
		expect(detachedView.preview).toEqual({ ref, turns });
		expect(detachedView.state.summaries).toEqual([detachedSummary]);
		controller.dispose();
	});

	// Of the eight `SessionSummary` fields, `status` and `updatedAt` move only
	// when a listing moves them, and every `sessions-changed` that fanned out
	// while the stream was down is gone: there is no cursor and no replay
	// buffer, and the opening snapshots carry neither field
	// (OW-vukoku). So the re-established stream is the whole trigger here -- no
	// event is emitted at all.
	it("re-lists when the socket opens again", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await settle();
		const missed = { ...summary(ref), status: "detached" as const, updatedAt: "2026-09-16T04:00:00.000Z" };
		server.on["sessions/list"].mockResolvedValue({ sessions: [missed] });

		server.drop();
		await reopen(controller);
		await settle();

		expect(controller.getView().state.summaries).toEqual([missed]);
		controller.dispose();
	});

	// A WebSocket does not retry, so without the client's own reconnect it
	// would sit in `reconnecting` until the user pressed Refresh, as a fatally
	// closed `EventSource` once did (OW-dekuri). Nothing here re-opens on its
	// own: the only opens are the ones the rebuilt connections earn, and the
	// healed sidebar at the end is the whole claim.
	it("opens the socket again on a fixed delay after a close until one opens, and heals with no user gesture (D31 point 6)", async () => {
		vi.useFakeTimers();
		try {
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(server.sockets.length).toBe(1);
			const missed = { ...summary(ref), status: "detached" as const, updatedAt: "2026-09-16T04:00:00.000Z" };
			server.on["sessions/list"].mockResolvedValue({ sessions: [missed] });

			server.failing = 1;
			server.drop();
			expect(controller.getView().connection).toBe("reconnecting");
			await vi.advanceTimersByTimeAsync(4_999);
			expect(server.sockets.length).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(server.sockets.length).toBe(2);
			expect(controller.getView().connection).toBe("reconnecting");

			// A failed open closes too: the retry keeps going rather than stopping at one try.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(server.sockets.length).toBe(3);
			expect(controller.getView().connection).toBe("connected");
			expect(controller.getView().state.summaries).toEqual([missed]);

			// A pending retry does not outlive the controller.
			server.drop();
			controller.dispose();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(server.sockets.length).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	// What a pasted token calls (`TokenPrompt.svelte`): the socket opens now, not
	// at the delay's end, and the delay it replaced opens no second one.
	it("reconnects at once when asked while a retry is pending, and that retry then opens nothing", async () => {
		vi.useFakeTimers();
		try {
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			await vi.advanceTimersByTimeAsync(0);

			// Up, there is nothing to reconnect.
			controller.reconnect();
			expect(server.sockets.length).toBe(1);

			server.drop();
			await vi.advanceTimersByTimeAsync(1_000);
			controller.reconnect();
			expect(server.sockets.length).toBe(2);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(server.sockets.length).toBe(2);

			// Asked twice, it opens one.
			server.drop();
			controller.reconnect();
			controller.reconnect();
			expect(server.sockets.length).toBe(3);

			server.drop();
			controller.dispose();
			controller.reconnect();
			expect(server.sockets.length).toBe(3);
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
	{
		it("drops every live view at once, leaving the selection detached, when the socket closes", async () => {
			const server = fakeServer();
			const streaming = { ...summary(ref), isStreaming: true };
			const virtual = { ...summary(virtualRef), status: "virtual" as const, onDisk: false };
			const fileless = { ...summary(forkedRef), onDisk: false };
			const stored: SessionSummary = { ...summary(storedRef), status: "detached" };
			delete stored.handle;
			server.on["sessions/list"].mockResolvedValue({ sessions: [streaming, summary(attachedRef), virtual, fileless, stored] });
			const controller = createController(server.api());
			await controller.start();
			server.emit(opening(ref));
			server.emit(opening(attachedRef));
			await controller.preview(attachedRef);
			controller.setDraft("sent to nobody");
			expect(Object.keys(controller.getView().state.sessions)).toHaveLength(2);

			server.on["sessions/preview"].mockClear();

			server.drop();

			expect(controller.getView().state.sessions).toEqual({});
			expect(controller.getView().state.selected).toEqual(attachedRef);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
			// The rows say so too: every one reads detached and idle, keeping the
			// handle a reconnect's opening snapshot pairs by, and one with nothing
			// on disk stands until the reconnect's listing drops it (D26).
			expect(controller.getView().state.summaries).toEqual([
				{ ...streaming, status: "detached", isStreaming: false },
				{ ...summary(attachedRef), status: "detached" },
				{ ...virtual, status: "detached" },
				{ ...fileless, status: "detached" },
				stored,
			]);
			expect(await controller.submit()).toBeNull();
			expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
			controller.dispose();
		});
	}

	// The drop keeps a selection with nothing on disk and its row as it keeps
	// any other: whether anything is left to show is the preview's to say once
	// a server can answer it, and one that no longer holds the session answers
	// `gone` (D26 point 6). The reconnect's listing drops the row.
	it("keeps a live selection with nothing on disk through a drop, and clears it once the reconnect's preview answers gone", async () => {
		const server = fakeServer();
		server.on["sessions/list"].mockResolvedValue({ sessions: [{ ...summary(forkedRef), onDisk: false }] });
		const controller = createController(server.api());
		await controller.start();
		server.emit(opening(forkedRef));
		await controller.preview(forkedRef);
		expect(paneMode(controller.getView())).toBe("live");
		server.on["sessions/preview"].mockClear();
		server.on["sessions/preview"].mockRejectedValue(gone());

		server.drop();
		expect(controller.getView().state.selected).toEqual(forkedRef);
		expect(controller.getView().state.summaries.map((item) => item.ref)).toEqual([forkedRef]);
		expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
		server.on["sessions/list"].mockResolvedValue({ sessions: [] });
		await reopen(controller);
		await settle();

		expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: forkedRef });
		expect(controller.getView().state.selected).toBeNull();
		expect(controller.getView().state.summaries).toEqual([]);
		controller.dispose();
	});

	// A preview is not live, so the drop leaves it on screen with its Attach,
	// and its own poll re-reads it once the server answers again.
	it("keeps a stored session's preview through a drop", async () => {
		const server = fakeServer();
		const turns = [previewAssistant("stored")];
		server.on["sessions/preview"].mockResolvedValue({ ref: attachedRef, turns });
		const controller = createController(server.api());
		await controller.start();
		server.emit(opening(ref));
		await controller.preview(attachedRef);

		server.drop();

		expect(controller.getView().state.sessions).toEqual({});
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().preview).toEqual({ ref: attachedRef, turns });
		controller.dispose();
	});

	// A preview is not live, so the drop leaves one with nothing on disk on
	// screen too, and the reconnect's listing re-reads it (OW-76): a server
	// that no longer holds the session answers `gone` (D26 point 6).
	it("keeps a previewed selection with nothing on disk through a drop, and clears it once the reconnect's re-read answers gone", async () => {
		const server = fakeServer();
		server.on["sessions/list"].mockResolvedValue({ sessions: [{ ...summary(virtualRef), status: "virtual", onDisk: false }] });
		const controller = createController(server.api());
		await controller.start();
		await controller.preview(virtualRef);
		expect(controller.getView().preview).not.toBeNull();

		server.drop();
		expect(controller.getView().state.selected).toEqual(virtualRef);
		expect(controller.getView().preview).not.toBeNull();
		server.on["sessions/list"].mockResolvedValue({ sessions: [] });
		server.on["sessions/preview"].mockRejectedValue(gone());
		await reopen(controller);
		await settle();

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
		const server = fakeServer();
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };
		const controller = createController(server.api());
		await controller.start();
		server.emit(opening(ref));
		server.drop();

		server.opening = [opening(renamed, h(ref))];
		// The reconnect's listing, still out: the row moves on the snapshot alone.
		server.on["sessions/list"].mockReturnValueOnce(new Promise(() => {}));
		await reopen(controller);

		expect(controller.getView().state.summaries.map((item) => item.ref)).toEqual([renamed]);
		expect(viewAt(controller, renamed)).toBeDefined();
		controller.dispose();
	});

	// App's auto-select asks for a preview before the first open, so the read
	// waits behind the `hello`, whose opening snapshots can introduce the
	// session before the read is answered. The pane reads live over it either
	// way (`paneMode`), and the reselect is what gives the live selection its
	// fork points, model list and pending flags.
	it("reselects the live session when a snapshot introduces it during its preview fetch", async () => {
		const server = fakeServer();
		server.holdOpen = true;
		server.opening = [opening(ref)];
		const fetch = deferred<SessionPreviewResponse>();
		server.on["sessions/preview"].mockReturnValue(fetch.promise);
		const controller = createController(server.api());
		const starting = controller.start();

		const previewing = controller.preview(ref);
		server.open();
		await starting;
		expect(viewAt(controller, ref)).toBeDefined();
		fetch.resolve({ ref, turns: [previewAssistant("stale")] });
		await previewing;

		expect(controller.getView().preview).toBeNull();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(server.on["sessions/forkPoints"]).toHaveBeenCalledWith({ handle: h(ref) });
		controller.dispose();
	});

	// A drop the server survived still costs the tab its views, and the
	// server's opening snapshots at the reconnect are what put back each one it
	// still holds (D25).
	it("re-introduces a session the server still holds from the reconnect's opening snapshot", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		server.emit(opening(ref));
		server.drop();
		expect(viewAt(controller, ref)).toBeUndefined();

		server.opening = [opening(ref)];
		await reopen(controller);

		expect(viewAt(controller, ref)?.messages).toHaveLength(1);
		controller.dispose();
	});

	// The startup listing goes out behind the `hello`, so its live read follows
	// the server's registration of this client, and a change after it reaches
	// the tab as an event (D21, D31 point 1). The first open asks no listing
	// of its own, wherever it lands against that one (OW-dajove).
	it("asks no listing of its own at a first open the startup listing went out on", async () => {
		const server = fakeServer();
		const listed = deferred<SessionSummary[]>();
		server.on["sessions/list"].mockReturnValueOnce(listed.promise.then((sessions) => ({ sessions })));
		const controller = createController(server.api());
		const starting = controller.start();

		listed.resolve([summary(ref)]);
		await starting;
		await settle();

		expect(server.on["sessions/list"]).toHaveBeenCalledOnce();
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		controller.dispose();
	});

	// A page loaded while the server was away: the first socket failed to
	// open, the api refused the startup listing it held as `unreachable`, and
	// `refreshSessions` swallows the rejection, so nothing retries it. The
	// open that follows, the server coming back, is the one that fills the
	// sidebar (OW-vukoku, OW-dajove).
	it("lists on the open that follows a first socket the startup listing failed with", async () => {
		const server = fakeServer();
		server.failing = 1;
		const controller = createController(server.api());
		await controller.start();
		await settle();
		expect(server.on["sessions/list"]).not.toHaveBeenCalled();
		expect(controller.getView().state.summaries).toEqual([]);

		await reopen(controller);
		await settle();

		expect(server.on["sessions/list"]).toHaveBeenCalledOnce();
		expect(controller.getView().state.summaries).toEqual([summary(ref)]);
		controller.dispose();
	});

	// Every backend replaces the `virtual:` id at attach and none writes before
	// the first turn (D9), so a session created here and detached before its
	// first prompt holds an ordinary-looking id with nothing behind it. Its
	// summary says so, and the id does not (OW-wedupe).
	const createdRef: SessionRef = { backend: "pi", id: "/sessions/created.jsonl" };

	// A detached session with nothing on disk is gone everywhere -- no file, and
	// dropped from the manager's table -- but its row stands in `summaries`
	// until the next listing, as a stored session's stale stripe does (D21):
	// a detach asks no listing of its own. A click on the row reads `gone` and
	// lands on the startup view, which is what makes it harmless (D26 point 6).
	// The row is a listing's, as every row is (D28).
	it("leaves the row of a detached session with nothing on disk to the next listing, and a click on it lands on the startup view", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await settle();
		attachesWith(server, snapshotOf(createdRef), "sessions/create", { onDisk: false });
		await controller.create("/work", "pi");
		server.on["sessions/list"].mockResolvedValue({ sessions: [{ ...summary(createdRef), onDisk: false }] });
		await controller.refreshSessions();
		server.on["sessions/list"].mockClear();
		server.on["sessions/preview"].mockRejectedValue(gone());
		// The listing the close's `sessions-changed` asks, still out.
		server.on["sessions/list"].mockReturnValueOnce(new Promise(() => {}));

		await controller.detach();
		await settle();
		expect(server.on["sessions/list"]).toHaveBeenCalledOnce();
		expect(controller.getView().state.summaries.map((item) => sessionKey(item.ref))).toContain(sessionKey(createdRef));

		server.on["sessions/preview"].mockClear();
		await controller.preview(createdRef);

		expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: createdRef });
		expect(controller.getView().state.selected).toBeNull();
		expect(controller.getView().error).toBeNull();
		controller.dispose();
	});

	// Nothing on disk and nobody holding the session once it is closed, so its
	// preview answers `gone` rather than an empty transcript whose only control
	// would be an Attach the server can no longer honour (OW-vasubu, D26).
	it("clears the selection onto the startup view when the session detached before its first turn was renamed at attach", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] }, "sessions/create", { onDisk: false });
		await controller.create("/work", "pi");
		expect(controller.getView().state.selected).toEqual(createdRef);
		await settle();
		server.on["sessions/preview"].mockClear();
		server.on["sessions/preview"].mockRejectedValue(gone());
		server.on["sessions/list"].mockClear();
		const closing = deferred<void>();
		server.on["sessions/close"].mockReturnValueOnce(closing.promise);

		const detaching = controller.detach();
		await settle();
		// The `ended` the server writes before it answers the close (D31 point 3).
		server.emit({ type: "ended", session: createdRef, handle: h(createdRef) });
		await settle();
		closing.resolve();
		await detaching;
		await settle();

		const detachedView = controller.getView();
		expect(server.on["sessions/close"]).toHaveBeenCalledWith({ ref: createdRef });
		expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: createdRef });
		expect(detachedView.state.selected).toBeNull();
		expect(detachedView.preview).toBeNull();
		expect(detachedView.previewFailure).toBeNull();
		expect(detachedView.state.sessions[h(createdRef)]).toBeUndefined();
		// No listing of its own: the row goes at the next one (D26).
		expect(server.on["sessions/list"]).not.toHaveBeenCalled();
		controller.dispose();
	});

	// The server says `ended` where it lets go of the handle, before the
	// disposal the close answers after (D26), so the view drops while the close
	// is still out, and the detached-loading pane it leaves reads its preview
	// then: nothing waits for the close, and `gone` clears the selection.
	it("clears the selection of a session with nothing on disk whose ended lands before its close answers, without waiting for the close (OW-sodohi)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] }, "sessions/create", { onDisk: false });
		await controller.create("/work", "pi");
		await settle();
		server.on["sessions/preview"].mockClear();
		const closing = deferred<void>();
		server.on["sessions/close"].mockReturnValueOnce(closing.promise);

		server.on["sessions/preview"].mockRejectedValue(gone());

		const detaching = controller.detach();
		await settle();
		server.emit({ type: "ended", session: createdRef, handle: h(createdRef) });
		await settle();
		expect(controller.getView().state.sessions[h(createdRef)]).toBeUndefined();
		expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: createdRef });
		expect(controller.getView().state.selected).toBeNull();
		closing.resolve();
		await detaching;
		await settle();

		expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
		expect(controller.getView().state.selected).toBeNull();
		controller.dispose();
	});

	// A Codex fork at the first user message is a fresh thread with no rollout
	// when the fork returns, read on disk only after its first turn had run
	// (`codex-cli 0.156.0`, D9). This one is detached mid-turn, and its preview
	// answers `gone`.
	it("clears the selection onto the startup view when the detached fork has run no turn", async () => {
		const server = fakeServer();
		server.on["sessions/forkAndPrompt"].mockImplementation(() => ({
			session: server.attached(forkedRef, { seq: 1, isStreaming: true }, { onDisk: false }),
			disposition: "started",
		}));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");
		expect((await controller.forkAndSubmit(0))?.session.ref).toEqual(forkedRef);
		expect(controller.getView().state.selected).toEqual(forkedRef);
		await settle();
		server.on["sessions/preview"].mockClear();
		server.on["sessions/preview"].mockRejectedValue(gone());

		await controller.detach();
		await settle();

		const detachedView = controller.getView();
		expect(server.on["sessions/close"]).toHaveBeenCalledWith({ ref: forkedRef });
		expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: forkedRef });
		expect(detachedView.state.selected).toBeNull();
		expect(detachedView.preview).toBeNull();
		controller.dispose();
	});

	// The other side of the same answer: the preview decides, not the summary's
	// `onDisk`. Here the attach reply said nothing was on disk and no listing
	// has caught up with the first turn that has written the store since, and
	// the session still detaches onto its preview like any stored one
	// (OW-tewave), where a detach that read `onDisk` cleared it.
	it("previews a session created here whose summary has not caught up with its first turn on disk", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: createdRef, handle: h(createdRef), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] }, "sessions/create", { onDisk: false });
		await controller.create("/work", "pi");
		await settle();
		server.on["sessions/preview"].mockClear();
		const turns = [previewAssistant("first turn")];
		server.on["sessions/preview"].mockResolvedValue({ ref: createdRef, turns });

		await controller.detach();
		await settle();

		expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: createdRef });
		expect(controller.getView().state.selected).toEqual(createdRef);
		expect(controller.getView().preview).toEqual({ ref: createdRef, turns });
		controller.dispose();
	});

	it("leaves the selection where a click landed it while the detach's close was still in flight", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		const closing = deferred<void>();
		server.on["sessions/close"].mockReturnValueOnce(closing.promise);

		const detaching = controller.detach();
		await settle();
		await controller.preview(attachedRef);
		expect(controller.getView().state.selected).toEqual(attachedRef);

		closing.resolve();
		await detaching;

		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(server.on["sessions/preview"].mock.calls.map(([params]) => params.ref)).not.toContainEqual(ref);
		controller.dispose();
	});

	// A gap inside a detach's window used to re-attach, spawning the subprocess
	// the user just asked to be rid of (OW-sugome); since D25 a gap attaches
	// nothing, and the detach still ends where it would have.
	it("does not re-attach a session whose detach is still in flight when its sequence gaps", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		const closing = deferred<void>();
		server.on["sessions/close"].mockReturnValueOnce(closing.promise);

		const detaching = controller.detach();
		await settle();
		server.on["sessions/attach"].mockClear();
		server.emit({ type: "status", session: ref, handle: h(ref), seq: 7, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await settle();

		closing.resolve();
		await detaching;
		await settle();

		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().preview).toEqual({ ref, turns: [] });
		controller.dispose();
	});

	it("rejects a relative workspace before creating a session", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();

		await controller.create("work/project", "pi");

		expect(server.on["sessions/create"]).not.toHaveBeenCalled();
		expect(controller.getView().error).toBe("Workspace must be an absolute path.");
	});

	// A prompt the backend handled itself leaves the held error standing
	// (OW-fakazi), so its reply comes with no `error-cleared` before it.
	it("keeps a session's turn error through a handled prompt's reply until the server says it cleared it (OW-lohubo)", async () => {
		const server = fakeServer();
		server.on["sessions/prompt"].mockResolvedValueOnce({ disposition: "handled" });
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");

		controller.setDraft("/mcp");
		expect(await controller.submit()).toBe("handled");

		// The reply alone drops nothing: the server owns the error.
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");
		server.emit({ type: "error-cleared", session: ref, handle: h(ref), seq: 3 });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
	});

	it("keeps an error with the held text that the new turn raised before its prompt's reply (OW-lohubo)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// The server admits the prompt and clears the error, then the new turn
		// fails at once with the same text, all before the reply.
		server.emit({ type: "error-cleared", session: ref, handle: h(ref), seq: 3 });
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 4, message: "The turn ended in an error.", errorId: "e2" });
		prompt.resolve({ disposition: "started" });
		await submitted;

		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");
	});

	it("does not clear a fresh same-turn error that arrives before the prompt's reply (D31 point 3)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);

		controller.setDraft("try again");
		const submitted = controller.submit();

		// A genuine error for *this* turn arrives before the prompt's own reply does.
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "This turn just failed.", errorId: "e1" });
		prompt.resolve({ disposition: "started" });
		await submitted;

		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("This turn just failed.");
	});

	it("does not clear a model failure that lands before the prompt's reply", async () => {
		const server = fakeServer();
		const setting = deferred<void>();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/setModel"].mockReturnValue(setting.promise);
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: "opaque/a", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.preview(ref);
		controller.setDraft("start while setting");

		const set = controller.setModel("opaque/next");
		const submitted = controller.submit();
		expect(server.on["sessions/prompt"]).toHaveBeenCalledOnce();
		setting.reject(new Error("Model selection failed"));
		await set;
		expect(controller.getView().error).toBe("Model selection failed");

		prompt.resolve({ disposition: "started" });
		await submitted;
		expect(controller.getView().error).toBe("Model selection failed");
	});

	it("dismisses the view error and the selected session's persisted error", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });

		controller.clearError();

		expect(controller.getView().error).toBeNull();
		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
		// The server holds the error too, and would put it back on the next
		// snapshot if it were not told (OW-bipume).
		// It names the error it dismisses, so a newer one the server holds by
		// then is left standing.
		expect(server.on["sessions/dismissError"]).toHaveBeenCalledExactlyOnceWith({ handle: h(ref), errorId: "e1" });
	});

	it("dismisses the error on screen by the id the wire named it by, not its text (OW-jokoto)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "The turn ended in an error.", errorId: "e7", notices: [] });
		await controller.select(ref);

		controller.clearError();

		expect(server.on["sessions/dismissError"]).toHaveBeenCalledExactlyOnceWith({ handle: h(ref), errorId: "e7" });
	});

	it("sends with a prompt the id of the error on screen when the user sent it (OW-jokoto)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e7" });

		controller.setDraft("try again");
		await controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledExactlyOnceWith({ text: "try again", priorErrorId: "e7", handle: h(ref) });
	});

	it("drops an error a snapshot redrew after its dismissal once the server says it cleared it (OW-jopifu)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);
		server.emit({ type: "error", session: ref, handle: h(ref), seq: 2, message: "The turn ended in an error.", errorId: "e1" });

		controller.clearError();
		// A snapshot the server broadcast before the dismissal reached it.
		server.emit({ type: "snapshot", session: ref, handle: h(ref), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "The turn ended in an error.", errorId: "e1", notices: [] });
		expect(controller.getView().state.sessions[h(ref)]?.error).toBe("The turn ended in an error.");
		server.emit({ type: "error-cleared", session: ref, handle: h(ref), seq: 1 });

		expect(controller.getView().state.sessions[h(ref)]?.error).toBeNull();
	});

	it("tells the server nothing when the selected session holds no error to dismiss (OW-bipume)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { type: "snapshot", session: ref, handle: h(ref), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await controller.select(ref);

		controller.clearError();

		expect(server.on["sessions/dismissError"]).not.toHaveBeenCalled();
	});

	it("reads as compacting for the whole of the compaction request (OW-81)", async () => {
		const server = fakeServer();
		const compacting = deferred<void>();
		server.on["sessions/compact"].mockReturnValue(compacting.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);

		const compacted = controller.compact();

		expect(server.on["sessions/compact"]).toHaveBeenCalledWith({ handle: h(ref) });
		expect(controller.getView().busy).toBe("compacting");

		compacting.resolve();
		await compacted;

		expect(controller.getView().busy).toBe("idle");
	});

	/**
	 * OW-natiha. `server.on["sessions/compact"]()` resolving is *admission*, not completion: the
	 * backend's work is still running, and only its status/snapshot events end
	 * it. The click writes no phase (D31 point 7): the request out holds
	 * `compacting`, and the server's own status, written before its reply, is
	 * what the session reads.
	 */
	it("reads the compaction phase from the server alone, and compacting while its request is out (OW-natiha, D31 point 7)", async () => {
		const server = fakeServer();
		const compacting = deferred<void>();
		server.on["sessions/compact"].mockReturnValue(compacting.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);

		const compacted = controller.compact();
		expect(controller.getView()).toMatchObject({ busy: "compacting", compacting: true });
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBeNull();

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 1, isStreaming: false, compaction: "requesting", model: null, effort: null, unrestoredModel: null });
		compacting.resolve();
		await compacted;

		expect(controller.getView()).toMatchObject({ busy: "idle", compacting: false });
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("requesting");

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 2, isStreaming: false, compaction: "running", model: null, effort: null, unrestoredModel: null });
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("running");

		server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBeNull();
		controller.dispose();
	});

	it("reads compacting for the selected session alone (D31 point 7)", async () => {
		const server = fakeServer();
		const compacting = deferred<void>();
		server.on["sessions/compact"].mockReturnValue(compacting.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		server.emit(snapshotOf(attachedRef));

		const compacted = controller.compact();
		await controller.preview(attachedRef);
		expect(controller.getView().compacting).toBe(false);
		await controller.preview(ref);
		expect(controller.getView().compacting).toBe(true);

		compacting.resolve();
		await compacted;
		controller.dispose();
	});

	/**
	 * One of OW-husivu's two accepted races: a refused compaction cleared the
	 * "requesting" it could not tell from another client's. The client writes
	 * no compaction of its own (D31 point 7), so a refusal leaves the server's.
	 */
	it("leaves the server's requesting standing when its own compaction is refused (OW-husivu, D31 point 7)", async () => {
		const server = fakeServer();
		server.on["sessions/compact"].mockRejectedValue(new ApiClientError("backend_refused", "compaction refused"));
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, { ...snapshotOf(ref), compaction: "requesting" });
		await controller.select(ref);

		await controller.compact();

		expect(controller.getView().error).toBe("compaction refused");
		expect(controller.getView().state.sessions[h(ref)]?.compaction).toBe("requesting");
		controller.dispose();
	});

	/**
	 * OW-hezidi, as one request (D30). The fork point is addressed by the
	 * *transcript index* the clicked message has, so identical wording in two
	 * messages cannot confuse it, and a steered Codex turn's second user
	 * message cannot shift it onto a later turn (OW-roveze): the server matches
	 * the index against `ForkPoint.index`, which `session-manager.test.ts`
	 * pins. Nothing else goes out: no fork-points read at submit, no stop, no
	 * fork, attach or prompt of the client's own.
	 */
	it("sends one fork-and-prompt naming the clicked message's transcript index and the draft (OW-hezidi, D30)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		await settle();
		server.on["sessions/forkPoints"].mockClear();
		server.on["sessions/attach"].mockClear();
		controller.setDraft("reworded");

		await controller.forkAndSubmit(2);

		expect(server.on["sessions/forkAndPrompt"]).toHaveBeenCalledExactlyOnceWith({ handle: h(ref), index: 2, text: "reworded" });
		expect(server.on["sessions/forkPoints"]).not.toHaveBeenCalledWith({ handle: h(ref) });
		expect(server.on["sessions/abort"]).not.toHaveBeenCalled();
		expect(server.on["sessions/fork"]).not.toHaveBeenCalled();
		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
		expect(controller.getView().draft).toBe("");
	});

	it("sends the edited message's images with it (OW-hezidi)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");
		const images = [{ mimeType: "image/png", base64: "aGk=" }];

		await controller.forkAndSubmit(0, images);

		expect(server.on["sessions/forkAndPrompt"]).toHaveBeenCalledExactlyOnceWith({ handle: h(ref), index: 0, text: "reworded", images });
	});

	/** The fork's prompt answers the same two ways a plain one does (OW-yobayi). */
	it("resolves a landed fork with its prompt's disposition (OW-yobayi)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);

		controller.setDraft("/mcp");
		server.on["sessions/forkAndPrompt"].mockImplementationOnce(() => ({ session: server.attached(forkedRef), disposition: "handled" }));
		expect(await controller.forkAndSubmit(0)).toEqual({ session: summary(forkedRef), disposition: "handled" });

		// Forked again, from the fork the first one selected.
		controller.setDraft("reworded");
		expect((await controller.forkAndSubmit(0))?.disposition).toBe("started");
		expect(server.on["sessions/forkAndPrompt"]).toHaveBeenLastCalledWith({ handle: h(forkedRef), index: 0, text: "reworded" });
	});

	/**
	 * The other half of OW-roveze: a message no point names, such as one
	 * steering added mid-turn. The server refuses it with nothing forked, never
	 * forking at the next point along (D20, D30), and the refusal names no fork,
	 * so the client stays where it is with the edited text. The shell normally
	 * draws no Edit control on such a message at all; reaching here means the
	 * transcript moved under the affordance.
	 */
	it("keeps the draft and the selection, and reports, when the server finds no fork point at that index (OW-roveze)", async () => {
		const server = fakeServer();
		server.on["sessions/forkAndPrompt"].mockRejectedValueOnce(new ApiClientError("not_a_fork_point", "no fork point at index 2"));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		expect(await controller.forkAndSubmit(2)).toBeNull();

		expect(controller.getView().draft).toBe("reworded");
		expect(controller.getView().state.selected).toEqual(ref);
		expect(controller.getView().error).toBe("no fork point at index 2");
		expect(controller.getView().sending).toBe(false);
	});

	/**
	 * A fork the server created whose prompt then failed (D30). Left on the
	 * parent, a second send forked the parent again and orphaned the first
	 * (ark3/agentpane#17), so the refusal names the fork and the selection
	 * moves there, with the text kept for the send that prompts it.
	 */
	it("moves to the fork a refusal names, keeping the draft, so sending again prompts the fork (D30)", async () => {
		const server = fakeServer();
		server.on["sessions/forkAndPrompt"].mockImplementationOnce(() => {
			// The fork's snapshot, broadcast before its prompt went out.
			server.attached(forkedRef);
			throw new ApiClientError("backend_refused", "the backend refused the prompt", { ref: forkedRef, handle: h(forkedRef) });
		});
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		server.on["sessions/forkPoints"].mockClear();
		controller.setDraft("reworded");

		expect(await controller.forkAndSubmit(0)).toBeNull();

		const refused = controller.getView();
		expect(refused.state.selected).toEqual(forkedRef);
		expect(paneMode(refused)).toBe("live");
		expect(refused.draft).toBe("reworded");
		expect(refused.error).toBe("the backend refused the prompt");
		expect(server.on["sessions/forkPoints"]).toHaveBeenCalledWith({ handle: h(forkedRef) });

		await controller.submit();
		expect(server.on["sessions/prompt"]).toHaveBeenCalledWith(expect.objectContaining({ text: "reworded", handle: h(forkedRef) }));
		expect(server.on["sessions/forkAndPrompt"]).toHaveBeenCalledOnce();
		controller.dispose();
	});

	/** Its own start failed, so nothing holds it live, and the pane reads it detached (`paneMode`). */
	it("moves to a fork the refusal names with no handle, on a pane that is not live (D30)", async () => {
		const server = fakeServer();
		server.on["sessions/forkAndPrompt"].mockRejectedValueOnce(
			new ApiClientError("internal_error", "spawn failed", { ref: forkedRef, handle: null }),
		);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		expect(await controller.forkAndSubmit(0)).toBeNull();

		const refused = controller.getView();
		expect(refused.state.selected).toEqual(forkedRef);
		expect(paneMode(refused)).not.toBe("live");
		expect(refused.draft).toBe("reworded");
		expect(refused.forkIndices).toBeNull();
		controller.dispose();
	});

	/** The click owns the selection, the refusal's fork included (D17, OW-miyemo). */
	it("leaves the selection where a click put it when the refusal that names a fork comes after (D17, D30)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const server = fakeServer();
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValueOnce(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await controller.select(other);
		server.attached(forkedRef);
		forking.reject(new ApiClientError("backend_refused", "refused", { ref: forkedRef, handle: h(forkedRef) }));

		expect(await submitted).toBeNull();
		expect(controller.getView().state.selected).toEqual(other);
		expect(controller.getView().draft).toBe("reworded");
		controller.dispose();
	});

	it("ends selected on the fork the reply names, attaching nothing itself (OW-hezidi, D30)", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		server.on["sessions/attach"].mockClear();
		controller.setDraft("reworded");

		await controller.forkAndSubmit(0);

		// The server attached the fork inside the operation.
		expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
		expect(controller.getView().state.selected).toEqual(forkedRef);
	});

	/**
	 * Whether a fork stops a running turn is the server's to decide (D30): the
	 * Pi adapter's fork stops it, and the Codex and Claude parents survive a
	 * mid-stream fork with their whole reply durable (OW-gojado, OW-japuzo).
	 * So no client sends a stop of its own, whatever the backend.
	 */
	it.each([["pi"], ["codex"], ["claude"]] as const)(
		"sends no stop of its own ahead of a fork of a streaming %s session (D15, D30)",
		async (backend) => {
			const parent: SessionRef = { backend, id: `${backend}-parent` };
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			attachesWith(server, { type: "snapshot", session: parent, handle: h(parent), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
			await controller.select(parent);
			controller.setDraft("reworded");

			expect((await controller.forkAndSubmit(0))?.session.ref).toEqual(forkedRef);

			expect(server.on["sessions/abort"]).not.toHaveBeenCalled();
			expect(server.on["sessions/forkAndPrompt"]).toHaveBeenCalledExactlyOnceWith({ handle: h(parent), index: 0, text: "reworded" });
			controller.dispose();
		},
	);

	/**
	 * A fork is a selection change, but not one that outranks a click that
	 * happened while it was in flight (OW-mifuki). The user gave up on *going to*
	 * the fork and went somewhere else -- and that is all they gave up on: under
	 * D17 the click is navigation, not a retraction, so the server still makes,
	 * attaches and prompts the fork, and they end up with both conversations
	 * (OW-miyemo).
	 */
	it("lands a fork whose selection was overtaken by a click mid-flight, without moving the user (D17, OW-miyemo)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const server = fakeServer();
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValueOnce(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await controller.select(other);
		forking.resolve({ session: server.attached(forkedRef), disposition: "started" });

		expect((await submitted)?.session.ref).toEqual(forkedRef);
		expect(controller.getView().state.selected).toEqual(other);
		controller.dispose();
	});

	/**
	 * What "Stop and fork" reads (D30): the server's answer for that session,
	 * kept under its handle, so a label never reads another session's.
	 */
	it("keeps each session's fork-stops-turn answer under its own handle (D30)", async () => {
		const other: SessionRef = { backend: "codex", id: "thread-other" };
		const server = fakeServer();
		server.on["sessions/forkPoints"].mockImplementation(async ({ handle }) => ({ points: [], forkStopsTurn: handle === h(ref) }));
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		await settle();
		await controller.select(other);
		await settle();

		expect(controller.getView().forkStopsTurn).toEqual({ [h(ref)]: true, [h(other)]: false });
		controller.dispose();
	});

	/**
	 * A row click on a live session reselects it without an attach, which is
	 * where fork points are otherwise read; one this tab was never told about,
	 * introduced while another session was on screen, is asked at the click.
	 */
	it("asks a live session reselected by a row click whether its fork stops a turn, once (D30)", async () => {
		const other: SessionRef = { backend: "codex", id: "thread-other" };
		const server = fakeServer();
		server.on["sessions/forkPoints"].mockResolvedValue({ points: [], forkStopsTurn: true });
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		// Live in this tab, by an opening snapshot, with `ref` on screen.
		server.emit(snapshotOf(other));
		await settle();
		server.on["sessions/forkPoints"].mockClear();

		await controller.preview(other);
		await settle();
		expect(server.on["sessions/forkPoints"]).toHaveBeenCalledExactlyOnceWith({ handle: h(other) });
		expect(controller.getView().forkStopsTurn[h(other)]).toBe(true);

		await controller.preview(ref);
		await controller.preview(other);
		await settle();
		expect(server.on["sessions/forkPoints"]).toHaveBeenCalledOnce();
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
		const server = fakeServer();
		const points = deferred<ForkPointsResponse>();
		server.on["sessions/forkPoints"].mockReturnValueOnce(points.promise);
		const controller = createController(server.api());
		await controller.start();
		attachesWith(server, snapshotOf(ref));
		await controller.select(ref);
		expect(server.on["sessions/forkPoints"]).toHaveBeenCalledWith({ handle: h(ref) });

		server.emit({ type: "status", session: renamed, handle: h(ref), seq: 2, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		points.resolve({ points: [{ id: "turn-1", text: "first", index: 0 }], forkStopsTurn: false });
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
		const server = fakeServer();
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValueOnce(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		// The user's own attach is still in flight when the fork's reply lands
		// and publishes underneath it.
		const attachingOther = deferred<SessionRef>();
		server.on["sessions/attach"].mockReturnValueOnce(lands(server, attachingOther.promise));
		const selecting = controller.select(other);
		await settle();
		forking.resolve({ session: server.attached(forkedRef), disposition: "started" });
		expect((await submitted)?.session.ref).toEqual(forkedRef);
		attachingOther.resolve(other);
		await selecting;

		expect(controller.getView().state.selected).toEqual(other);
		expect(controller.getView().busy).toBe("idle");
		controller.dispose();
	});

	/**
	 * The other side of the guard above: a landed prompt is not abandoned,
	 * whatever the user clicked. The fork is reported back so the caller can
	 * arm its per-tab state on the right session, and the draft is cleared even
	 * though the selection has moved -- one draft, one composer, and it must not
	 * go on offering text that was already sent (OW-mifuki).
	 */
	it("reports the fork it landed on, and clears the draft, when a click moved the selection meanwhile (OW-mifuki)", async () => {
		const other: SessionRef = { backend: "pi", id: "/sessions/other.jsonl" };
		const server = fakeServer();
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValueOnce(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		await controller.select(other);
		forking.resolve({ session: server.attached(forkedRef), disposition: "started" });

		expect((await submitted)?.session.ref).toEqual(forkedRef);
		expect(controller.getView().draft).toBe("");
		expect(controller.getView().state.selected).toEqual(other);
	});

	/**
	 * The click that lands on the fork's *own* row, rather than away from it
	 * (OW-tatebi). The fork still declines the selection -- the user's click owns
	 * `selectionIntent` -- but `selectAttached` moves the selection anyway,
	 * because the selection it finds is already the fork. The live
	 * transcript then has to take over from the read-only preview that click
	 * opened, or the user reads a frozen copy of a session that is streaming;
	 * it does once the fork's snapshot, written before the reply, gives this
	 * tab a view (`paneMode`, OW-forinu).
	 */
	it("goes live over the preview the declined click opened on the fork itself, once the fork's snapshot lands (OW-tatebi)", async () => {
		const server = fakeServer();
		server.on["sessions/preview"].mockResolvedValue({ ref: forkedRef, turns: [previewAssistant("stale")] });
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValueOnce(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		// The fork is listed by now, and the click lands on it while the request
		// is still out.
		await controller.preview(forkedRef);
		expect(paneMode(controller.getView())).toBe("preview");
		forking.resolve({ session: server.attached(forkedRef), disposition: "started" });

		expect((await submitted)?.session.ref).toEqual(forkedRef);
		expect(controller.getView().state.selected).toEqual(forkedRef);
		expect(paneMode(controller.getView())).toBe("live");
		expect(controller.getView().preview).toBeNull();
		controller.dispose();
	});

	/**
	 * The rule `submit` has always had, brought to the fork path (OW-kelede).
	 * Two fast presses in edit mode -- Ctrl-Enter twice, or Enter then a click on
	 * the fork button -- used to start two whole forks.
	 */
	it("forks once when the fork path is entered twice while the first is still in flight (OW-kelede)", async () => {
		const server = fakeServer();
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValue(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const first = controller.forkAndSubmit(0);
		const second = controller.forkAndSubmit(0);
		await settle();

		expect(server.on["sessions/forkAndPrompt"]).toHaveBeenCalledOnce();
		forking.resolve({ session: server.attached(forkedRef), disposition: "started" });
		expect(await second).toBeNull();
		expect((await first)?.session.ref).toEqual(forkedRef);
		controller.dispose();
	});

	/**
	 * The fork's request runs until its prompt is admitted, so the window in
	 * which the user types the next prompt into a live textarea is wide -- and
	 * the clear used to be unconditional and wipe it (OW-kelede). `submit`'s
	 * rule covers both cases at once: a click away does not change the draft,
	 * so that one still clears.
	 */
	it("keeps a draft typed while the fork was in flight (OW-kelede)", async () => {
		const server = fakeServer();
		const forking = deferred<ForkAndPromptResponse>();
		server.on["sessions/forkAndPrompt"].mockReturnValue(forking.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("reworded");

		const submitted = controller.forkAndSubmit(0);
		await settle();
		controller.setDraft("and the next thing");
		forking.resolve({ session: server.attached(forkedRef), disposition: "started" });

		expect((await submitted)?.session.ref).toEqual(forkedRef);
		expect(controller.getView().draft).toBe("and the next thing");
		controller.dispose();
	});

	/**
	 * `busy` is one global slot, so it never was a sound in-flight signal
	 * (OW-kelede): prompt a session, watch the turn start streaming ahead of the
	 * prompt's own reply (D31 point 3), press Stop, and `abort`'s `finally` publishes
	 * `"idle"` over the `"submitting"` of a prompt that is still outstanding.
	 * The guards read the flag the two send paths own instead.
	 */
	it("refuses a second submit after an abort answered under the first, and reads busy from the prompt still out (OW-kelede, D31 point 7)", async () => {
		const server = fakeServer();
		const prompt = deferred<PromptResponse>();
		server.on["sessions/prompt"].mockReturnValue(prompt.promise);
		const controller = createController(server.api());
		await controller.start();
		await controller.select(ref);
		controller.setDraft("hello");
		const first = controller.submit();
		await settle();

		await controller.abort();
		// The stop's answer once wrote idle over the prompt's `"submitting"`.
		expect(controller.getView()).toMatchObject({ busy: "submitting", sending: true });
		const second = controller.submit();

		expect(server.on["sessions/prompt"]).toHaveBeenCalledOnce();
		prompt.resolve({ disposition: "started" });
		expect(await second).toBeNull();
		await first;
		controller.dispose();
	});

	it("closes the socket at disposal", async () => {
		const server = fakeServer();
		const controller = createController(server.api());
		await controller.start();
		controller.dispose();

		expect(server.sockets).toHaveLength(1);
		expect(server.sockets[0]!.closedWith).toEqual({ code: 1000, reason: "the client is leaving" });
	});

	/**
	 * The preview poll (OW-76). All of these drive the *real* `createController`
	 * with a fake api on purpose: `App.test.ts`'s `FakeController.preview` only
	 * records the call and never replaces `turns`, so a poll test written against
	 * it would assert call counts while proving nothing about the transcript.
	 */
	describe("preview self-refresh", () => {
		const otherRef: SessionRef = { backend: "codex", id: "thread-other" };

		function growingPreview(server: SocketServer, turns: () => SessionPreviewTurn[]) {
			server.on["sessions/preview"].mockImplementation(async ({ ref: session }) => ({ ref: session, turns: turns() }));
		}

		it("polls a showing preview, speeds up on a change, and backs off to the ceiling", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
				growingPreview(server, () => turns);
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				server.on["sessions/preview"].mockClear();

				// Starts quiet: nothing until the 16s idle delay is actually up.
				await vi.advanceTimersByTimeAsync(15_999);
				expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
				turns = [...turns, previewAssistant("there")];
				await vi.advanceTimersByTimeAsync(1);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(1);
				expect(controller.getView().preview?.turns).toHaveLength(2);

				// Having found a change, the next fetch lands 1s later, not 16.
				turns = [...turns, { role: "user", content: "more" }];
				await vi.advanceTimersByTimeAsync(999);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
				expect(controller.getView().preview?.turns).toHaveLength(3);

				// Quiet from here: the gap stretches back out and then holds at 16s.
				let fetches = 2;
				for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000]) {
					await vi.advanceTimersByTimeAsync(delay - 1);
					expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(fetches);
					await vi.advanceTimersByTimeAsync(1);
					fetches += 1;
					expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(fetches);
				}

				// Polling never touches the selection, and never attaches.
				expect(controller.getView().state.selected).toEqual(ref);
				expect(server.on["sessions/attach"]).not.toHaveBeenCalled();
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("re-reads the preview when the sessions are refreshed, not just the sidebar", async () => {
			const server = fakeServer();
			let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
			growingPreview(server, () => turns);
			const controller = createController(server.api());
			await controller.start();
			await controller.preview(ref);
			server.on["sessions/preview"].mockClear();
			turns = [...turns, previewAssistant("there")];

			await controller.refreshSessions();

			expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(1);
			expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: ref });
			expect(controller.getView().preview?.turns).toHaveLength(2);
			expect(controller.getView().state.selected).toEqual(ref);
			controller.dispose();
		});

		it("resets the poll to its fastest rate when a returning tab finds a change, and leaves it alone when it does not", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
				growingPreview(server, () => turns);
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				server.on["sessions/preview"].mockClear();

				// What App.svelte's visibilitychange/focus listener calls.
				turns = [...turns, previewAssistant("there")];
				await controller.refreshPreview();
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(1);
				expect(controller.getView().preview?.turns).toHaveLength(2);

				// A second gesture, this one finding nothing, must not back the delay
				// off: backoff measures how quiet the file is, and a gesture is not
				// evidence about that. Only a timer tick may stretch the gap.
				await controller.refreshPreview();
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);

				// So the next *poll* still lands 1s after the change, not 16s and not 2s.
				await vi.advanceTimersByTimeAsync(999);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(3);
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("never polls a hidden tab, and picks up again when it comes back", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				let visible = true;
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				const controller = createController(server.api(), () => visible);
				await controller.start();
				await controller.preview(ref);
				server.on["sessions/preview"].mockClear();

				// The visibilitychange on the way *out* is the same call as on the way in.
				visible = false;
				await controller.refreshPreview();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(server.on["sessions/preview"]).not.toHaveBeenCalled();

				visible = true;
				await controller.refreshPreview();
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(16_000);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("stops polling on attach, and a fetch that lands afterwards cannot put the preview back", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				server.on["sessions/attach"].mockImplementation(() => ({ session: server.attached(attachedRef) }));
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);

				// A poll is in flight at the moment the user attaches.
				const late = deferred<SessionPreviewResponse>();
				server.on["sessions/preview"].mockReturnValueOnce(late.promise);
				await vi.advanceTimersByTimeAsync(16_000);
				await controller.select(ref);
				expect(controller.getView().preview).toBeNull();

				late.resolve({ ref, turns: [{ role: "user", content: "hi" }, previewAssistant("late")] });
				await late.promise;
				await vi.advanceTimersByTimeAsync(0);
				expect(controller.getView().preview).toBeNull();

				server.on["sessions/preview"].mockClear();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("polls the session now on screen, at a fresh idle delay, after the user switches previews", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				let turns: SessionPreviewTurn[] = [{ role: "user", content: "hi" }];
				growingPreview(server, () => turns);
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				// Drive the first session's poll down to its fastest rate.
				turns = [...turns, previewAssistant("there")];
				await vi.advanceTimersByTimeAsync(16_000);

				await controller.preview(otherRef);
				server.on["sessions/preview"].mockClear();

				// The busy session's 1s countdown does not carry over to the quiet one.
				await vi.advanceTimersByTimeAsync(15_999);
				expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(1);
				expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: otherRef });
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not cancel a click that is still in flight when a poll fires", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);

				// The user clicks another row, and its fetch is still in flight...
				await vi.advanceTimersByTimeAsync(15_000);
				const clicked = deferred<SessionPreviewResponse>();
				server.on["sessions/preview"].mockReturnValueOnce(clicked.promise);
				const clicking = controller.preview(otherRef);
				// ...when the poll for the preview still on screen fires. A refresh is
				// not a new selection: it captures the selection intent rather than
				// bumping it, or it would silently cancel the click.
				await vi.advanceTimersByTimeAsync(1_000);
				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(3);

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
				const server = fakeServer();
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [{ role: "user", content: "hi" }] });
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				server.on["sessions/preview"].mockClear();

				controller.dispose();
				await vi.advanceTimersByTimeAsync(60_000);

				expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
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
		// the `ended` the close sends drops the view (D26), and the server answers
		// the preview S's pane now needs.
		it("previews a selected session another client closes, and sends it nothing (OW-zivamo)", async () => {
			const server = fakeServer();
			const turns = [previewAssistant("stored")];
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			expect(paneMode(controller.getView())).toBe("live");
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockResolvedValue({ ref, turns });
			server.on["sessions/list"].mockResolvedValueOnce({ sessions: [{ ...summary(ref), status: "detached", isStreaming: false }] });

			server.emit({ type: "ended", session: ref, handle: h(ref) });
			server.emit({ type: "sessions-changed" });
			await settle();

			expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
			expect(paneMode(controller.getView())).toBe("preview");
			expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: ref });
			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.setDraft("sent to nobody");
			expect(await controller.submit()).toBeNull();
			expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
			controller.dispose();
		});

		// Another client closes S with the stream up, and the listing the close's
		// `sessions-changed` asks fails: the `ended` alone says the handle is gone
		// (D26), and no listing is needed to drop the view.
		it("drops the view of a selected session another client closes though the listing its close asks fails, and sends it nothing (D26)", async () => {
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			expect(paneMode(controller.getView())).toBe("live");
			server.on["sessions/list"].mockRejectedValueOnce(new Error("offline"));

			server.emit({ type: "ended", session: ref, handle: h(ref) });
			server.emit({ type: "sessions-changed" });
			await settle();

			expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
			expect(paneMode(controller.getView())).not.toBe("live");
			controller.setDraft("sent to nobody");
			expect(await controller.submit()).toBeNull();
			expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
			controller.dispose();
		});

		// The server exited with the attach still out: the request settles as the
		// connection lost, its outcome unknown (D31 point 6), and nothing is live.
		for (const path of ["select", "create", "forkAndSubmit"] as const) {
			it(`settles an attach still out at a stream drop as the connection lost, through ${path} (D31 point 6)`, async () => {
				const server = fakeServer();
				server.on["sessions/forkPoints"].mockResolvedValue({ points: [{ id: "turn-1", text: "first", index: 0 }], forkStopsTurn: false });
				const controller = createController(server.api());
				await controller.start();
				if (path === "forkAndSubmit") {
					await controller.select(ref);
					controller.setDraft("reworded");
				}
				const never = new Promise<never>(() => {});
				if (path === "forkAndSubmit") server.on["sessions/forkAndPrompt"].mockReturnValueOnce(never);
				else if (path === "create") server.on["sessions/create"].mockReturnValueOnce(never);
				else server.on["sessions/attach"].mockReturnValueOnce(never);

				const landing = path === "select"
					? controller.select(ref)
					: path === "create"
						? controller.create("/work", "pi")
						: controller.forkAndSubmit(0);
				await settle();
				expect(controller.getView().busy).not.toBe("idle");
				server.drop();
				await landing;
				await settle();

				const landed = controller.getView();
				expect(landed.state.sessions).toEqual({});
				expect(paneMode(landed)).not.toBe("live");
				expect(landed.state.summaries.filter((item) => item.status === "attached")).toEqual([]);
				expect(landed.busy).toBe("idle");
				expect(landed.error).toBe("the connection to the agentpane server was lost");
				if (path === "forkAndSubmit") expect(landed.draft).toBe("reworded");
				server.on["sessions/prompt"].mockClear();
				controller.setDraft("sent to nobody");
				expect(await controller.submit()).toBeNull();
				expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
				controller.dispose();
			});
		}

		// The attach's snapshot beats its reply (D31 point 3), a gap then drops the view it
		// made, and only then does the reply select the session.
		it("lands an attach whose snapshot's view a gap dropped before the reply on the detached-loading pane (OW-tefigi)", async () => {
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			const previewing = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockReturnValue(previewing.promise);
			const replying = deferred<void>();
			server.on["sessions/attach"].mockImplementationOnce(async () => {
				const session = server.attached(ref, { seq: 1 });
				await replying.promise;
				return { session };
			});

			const selecting = controller.select(ref);
			expect(controller.getView().state.sessions[h(ref)]).toBeDefined();
			server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			expect(controller.getView().state.sessions[h(ref)]).toBeUndefined();
			replying.resolve();
			await selecting;

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: ref });
			controller.setDraft("sent to nobody");
			expect(await controller.submit()).toBeNull();
			expect(server.on["sessions/prompt"]).not.toHaveBeenCalled();
			controller.dispose();
		});

		// Another client's attach, a gap on the selected session followed by any
		// snapshot of it, or a reconnect's opening snapshot over a kept preview.
		it("goes live when a snapshot introduces a view of the session whose preview is on screen (OW-tefigi)", async () => {
			const server = fakeServer();
			server.on["sessions/preview"].mockResolvedValue({ ref, turns: [previewAssistant("stored")] });
			const controller = createController(server.api());
			await controller.start();
			await controller.preview(ref);
			expect(paneMode(controller.getView())).toBe("preview");

			server.emit(snapshotOf(ref));

			expect(paneMode(controller.getView())).toBe("live");
			// Discarded, not merely outranked, so its poll has nothing to re-read.
			expect(controller.getView().preview).toBeNull();
			controller.dispose();
		});

		// The read was out when the stream dropped. The close settles it as the
		// connection lost (D31 point 6), and its failure, landing with the
		// stream down, neither holds nor writes a line; the reconnect's
		// `connected` asks a fresh read.
		it("asks a fresh preview at the reconnect when a read was out at the drop, whose failure holds nothing (OW-forinu, OW-bilogo, D31 point 6)", async () => {
			const server = fakeServer();
			const turns = [previewAssistant("stored")];
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockReturnValueOnce(new Promise(() => {}));
			server.on["sessions/preview"].mockResolvedValue({ ref, turns });

			server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
			server.drop();
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(controller.getView().previewFailure).toBeNull();

			await reopen(controller);
			await settle();

			expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// The server exits with the read out, and the read fails before the tab
		// hears the stream drop, so the stream still reads `connected`.
		it("keeps the selection for a preview read that fails before the drop is heard, and asks again at the next connected (OW-bilogo)", async () => {
			const server = fakeServer();
			const turns = [previewAssistant("stored")];
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockRejectedValueOnce(new Error("the backend exited"));
			server.on["sessions/preview"].mockResolvedValue({ ref, turns });

			server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();

			server.drop();
			await settle();
			expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
			await reopen(controller);
			await settle();

			expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// A read that never settles would hold its key in `previewLoads` for
		// good, and nothing would ever ask for that session's preview again.
		it("aborts a preview read that has not settled within its bound, and asks again at the next connected (OW-bilogo)", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				const turns = [previewAssistant("stored")];
				const controller = createController(server.api());
				await controller.start();
				await controller.select(ref);
				await vi.advanceTimersByTimeAsync(0);
				server.on["sessions/preview"].mockClear();
				server.on["sessions/preview"].mockReturnValueOnce(new Promise(() => {}));
				server.on["sessions/preview"].mockResolvedValue({ ref, turns });

				server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
				await vi.advanceTimersByTimeAsync(9_999);
				expect(controller.getView().previewFailure).toBeNull();
				await vi.advanceTimersByTimeAsync(1);

				expect(controller.getView().previewFailure).toEqual({ ref, message: "No answer within 10s." });
				expect(controller.getView().state.selected).toEqual(ref);
				expect(paneMode(controller.getView())).toBe("loading");
				expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();

				server.drop();
				await reopen(controller);
				await vi.advanceTimersByTimeAsync(0);

				expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
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
			const server = fakeServer();
			const turns = [previewAssistant("stored")];
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockRejectedValueOnce(new Error("preview failed"));

			server.emit({ type: "status", session: ref, handle: h(ref), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
			await settle();

			expect(controller.getView().previewFailure).toEqual({ ref, message: "preview failed" });
			expect(controller.getView().error).toBeNull();

			server.emit({ type: "sessions-changed" });
			controller.setDraft("unrelated");
			await settle();

			expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
			expect(paneMode(controller.getView())).toBe("loading");

			server.on["sessions/preview"].mockResolvedValue({ ref, turns });
			await controller.preview(ref);
			await settle();

			expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().previewFailure).toBeNull();
			controller.dispose();
		});

		// App's auto-select asks a click's read at startup, before the first
		// open, and never asks again for that row: the read waits behind the
		// `hello`, and its answer is the click's.
		it("lands a click whose read is out when the first open lands", async () => {
			const server = fakeServer();
			server.holdOpen = true;
			const turns = [previewAssistant("stored")];
			const reading = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockReturnValueOnce(reading.promise);
			const controller = createController(server.api());
			const starting = controller.start();

			const clicking = controller.preview(ref);
			server.open();
			await starting;
			reading.resolve({ ref, turns });
			await clicking;

			expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
			expect(controller.getView().state.selected).toEqual(ref);
			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.dispose();
		});

		// A preview is on screen through a drop, and the user clicks another row
		// before the stream is back: with no socket, the read is refused at once,
		// having been sent nowhere (D31).
		it("refuses at once a click made while the socket is down, leaving the preview on screen", async () => {
			const server = fakeServer();
			const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
			server.on["sessions/preview"].mockResolvedValue({ ref, turns: [previewAssistant("stored")] });
			const controller = createController(server.api());
			await controller.start();
			await controller.preview(ref);
			server.drop();
			server.on["sessions/preview"].mockClear();

			await controller.preview(otherRef);

			expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
			expect(controller.getView().state.selected).toEqual(ref);
			expect(controller.getView().error).toBe("could not reach the agentpane server");
			controller.dispose();
		});

		// The click lands while the reconnect's socket is opening: its read waits
		// behind the `hello` and is answered once the socket is up.
		for (const outcome of ["answers", "fails"] as const) {
			it(`lands a click made while the socket is opening whose read ${outcome} once it is up`, async () => {
				const server = fakeServer();
				const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [previewAssistant("stored")] });
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				server.drop();
				server.holdOpen = true;
				controller.reconnect();
				const reading = deferred<SessionPreviewResponse>();
				server.on["sessions/preview"].mockClear();
				server.on["sessions/preview"].mockImplementation(async ({ ref: asked }) =>
					asked.id === otherRef.id ? reading.promise : { ref, turns: [previewAssistant("stored")] });

				const clicking = controller.preview(otherRef);
				await settle();
				expect(server.on["sessions/preview"]).not.toHaveBeenCalled();
				server.open();
				await settle();
				expect(server.on["sessions/preview"]).toHaveBeenCalledWith({ ref: otherRef });
				const turns = [previewAssistant("other")];
				if (outcome === "answers") reading.resolve({ ref: otherRef, turns });
				else reading.reject(new Error("preview failed"));
				await clicking;

				if (outcome === "answers") {
					expect(controller.getView().state.selected).toEqual(otherRef);
					expect(controller.getView().preview).toEqual({ ref: otherRef, turns });
				} else {
					expect(controller.getView().state.selected).toEqual(ref);
					expect(controller.getView().error).toBe("preview failed");
				}
				controller.dispose();
			});
		}

		// An attach from the loading pane bumps the intent and fails; the read
		// out for that pane is still that session's transcript, and nothing
		// else will ask for it.
		it("opens a detached-loading pane's preview that answers after an attach from it failed", async () => {
			const server = fakeServer();
			const turns = [previewAssistant("stored")];
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			const reading = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockReturnValueOnce(reading.promise);
			server.emit({ type: "ended", session: ref, handle: h(ref) });
			server.on["sessions/attach"].mockRejectedValueOnce(new Error("attach failed"));

			await controller.select(ref);
			reading.resolve({ ref, turns });
			await settle();

			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.dispose();
		});

		// A drop leaves a session with a transcript on disk selected, and its
		// preview waits for a server that can answer it (D25 point 3).
		it("keeps a dropped selection detached-loading, and fetches its preview only once the stream is back (OW-forinu)", async () => {
			const server = fakeServer();
			const turns = [previewAssistant("stored")];
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockResolvedValue({ ref, turns });

			server.drop();
			await settle();

			expect(controller.getView().state.selected).toEqual(ref);
			expect(paneMode(controller.getView())).toBe("loading");
			expect(server.on["sessions/preview"]).not.toHaveBeenCalled();

			await reopen(controller);
			await settle();

			expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: ref });
			expect(paneMode(controller.getView())).toBe("preview");
			expect(controller.getView().preview).toEqual({ ref, turns });
			controller.dispose();
		});
	});

	/**
	 * A preview read of the selected session answered `gone` is the one place
	 * the browser learns its session is nowhere, and it clears the selection
	 * onto the startup view from each path that reads it (D26 point 6).
	 */
	describe("a preview answered gone", () => {
		const createdRef: SessionRef = { backend: "pi", id: "virtual:created" };

		// Formerly OW-lejape: another client closes it with the stream up, and
		// its `ended` drops the view (D26). Its other ordering, the reconnect's
		// preview answering gone, is "keeps a live selection with nothing on
		// disk through a drop" above.
		it("lands on the startup view when another client closes a selected session with nothing on disk", async () => {
			const server = fakeServer();
			server.on["sessions/attach"].mockImplementationOnce(() => ({ session: server.attached(ref, {}, { onDisk: false }) }));
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockRejectedValue(gone());

			server.emit({ type: "ended", session: ref, handle: h(ref) });
			await settle();

			const landed = controller.getView();
			expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: ref });
			expect(landed.state.selected).toBeNull();
			expect(landed.preview).toBeNull();
			expect(landed.previewFailure).toBeNull();
			controller.dispose();
		});

		// Closed elsewhere, or previewed across a restart: the poll is the only
		// read a pane already on its preview makes.
		it("lands on the startup view when the poll of the preview on screen answers gone, and polls no more", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [previewAssistant("stored")] });
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				expect(paneMode(controller.getView())).toBe("preview");
				server.on["sessions/preview"].mockClear();
				server.on["sessions/preview"].mockRejectedValue(gone());

				await vi.advanceTimersByTimeAsync(16_000);

				expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
				expect(controller.getView().state.selected).toBeNull();
				expect(controller.getView().preview).toBeNull();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		// The poll captures the intent rather than bumping it, and a click
		// that landed while it was out is the user's last word.
		it("clears nothing when the poll's gone lands after the user clicked elsewhere", async () => {
			vi.useFakeTimers();
			try {
				const server = fakeServer();
				const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
				server.on["sessions/preview"].mockResolvedValue({ ref, turns: [previewAssistant("stored")] });
				const controller = createController(server.api());
				await controller.start();
				await controller.preview(ref);
				const polled = deferred<SessionPreviewResponse>();
				server.on["sessions/preview"].mockReturnValueOnce(polled.promise);
				await vi.advanceTimersByTimeAsync(16_000);
				server.on["sessions/preview"].mockResolvedValueOnce({ ref: otherRef, turns: [previewAssistant("other")] });
				await controller.preview(otherRef);

				polled.reject(gone());
				await vi.advanceTimersByTimeAsync(0);

				expect(controller.getView().state.selected).toEqual(otherRef);
				expect(paneMode(controller.getView())).toBe("preview");
				controller.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		// Formerly OW-tuyewo: the click on the selected detached-loading row
		// joins the read `publish` already has out for it rather than asking a
		// second, and its failure is the pane's to show, once.
		it("reads a clicked detached-loading row's preview once, and reports that read's failure in one place", async () => {
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.on["sessions/preview"].mockClear();
			const reading = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockReturnValue(reading.promise);
			server.emit({ type: "ended", session: ref, handle: h(ref) });
			expect(paneMode(controller.getView())).toBe("loading");

			const clicking = controller.preview(ref);
			reading.reject(new Error("preview failed"));
			await clicking;
			await settle();

			expect(server.on["sessions/preview"]).toHaveBeenCalledOnce();
			expect(controller.getView().state.selected).toEqual(ref);
			expect(controller.getView().previewFailure).toEqual({ ref, message: "preview failed" });
			expect(controller.getView().error).toBeNull();
			controller.dispose();
		});

		// The exit that read `onDisk` kept this selection, on a pane whose
		// Attach the server could only refuse.
		it("lands a detach on the startup view when the preview answers gone, though the summary says the session is on disk", async () => {
			const server = fakeServer();
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			expect(controller.getView().state.summaries.find((item) => sessionKey(item.ref) === sessionKey(ref))?.onDisk).toBe(true);
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockRejectedValue(gone());

			await controller.detach();
			await settle();

			const landed = controller.getView();
			expect(server.on["sessions/close"]).toHaveBeenCalledWith({ ref: ref });
			expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: ref });
			expect(landed.state.selected).toBeNull();
			expect(landed.preview).toBeNull();
			expect(landed.previewFailure).toBeNull();
			controller.dispose();
		});

		// The background read asked for X belongs to the intent it was asked
		// under, and a click on Y has moved on from it: its `gone` clears
		// nothing, and the pane stays on X until Y's read lands.
		it("clears nothing when a detached-loading pane's gone lands after a click on another row", async () => {
			const server = fakeServer();
			const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			const background = deferred<SessionPreviewResponse>();
			const clicked = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockReturnValueOnce(background.promise).mockReturnValueOnce(clicked.promise);
			server.emit({ type: "ended", session: ref, handle: h(ref) });
			expect(paneMode(controller.getView())).toBe("loading");
			const selections: Array<SessionRef | null> = [];
			controller.subscribe((next) => selections.push(next.state.selected));

			const clicking = controller.preview(otherRef);
			background.reject(gone());
			await settle();
			clicked.resolve({ ref: otherRef, turns: [previewAssistant("other")] });
			await clicking;

			expect(selections).not.toContain(null);
			expect(controller.getView().state.selected).toEqual(otherRef);
			expect(paneMode(controller.getView())).toBe("preview");
			controller.dispose();
		});

		// The background read landed nowhere, and a publish before the click
		// lands -- a keystroke here -- finds the pane still waiting. No read of
		// it is asked while the click is out, or it would carry the click's
		// intent and its `gone` would clear the selection under the click.
		it("asks no read of the detached-loading pane while a click elsewhere is out", async () => {
			const server = fakeServer();
			const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			const background = deferred<SessionPreviewResponse>();
			const clicked = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockReturnValueOnce(background.promise).mockReturnValueOnce(clicked.promise).mockRejectedValue(gone());
			server.emit({ type: "ended", session: ref, handle: h(ref) });
			const selections: Array<SessionRef | null> = [];
			controller.subscribe((next) => selections.push(next.state.selected));

			const clicking = controller.preview(otherRef);
			background.reject(gone());
			await settle();
			controller.setDraft("typed while the click is out");
			await settle();
			clicked.resolve({ ref: otherRef, turns: [previewAssistant("other")] });
			await clicking;

			expect(server.on["sessions/preview"]).toHaveBeenCalledTimes(2);
			expect(selections).not.toContain(null);
			expect(controller.getView().state.selected).toEqual(otherRef);
			controller.dispose();
		});

		// The same, with a second click's own `publish({ error: null })` as the
		// publish: the click's read is registered before it, so that publish
		// finds a click's read out and asks nothing under that click's intent.
		it("asks no read of the detached-loading pane from a second click's own publish", async () => {
			const server = fakeServer();
			const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
			const thirdRef: SessionRef = { backend: "codex", id: "thread-third" };
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			const background = deferred<SessionPreviewResponse>();
			const clicks = new Map([
				[sessionKey(otherRef), deferred<SessionPreviewResponse>()],
				[sessionKey(thirdRef), deferred<SessionPreviewResponse>()],
			]);
			let asked = false;
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockImplementation(({ ref: session }) => {
				if (sessionKey(session) !== sessionKey(ref)) return clicks.get(sessionKey(session))!.promise;
				if (asked) return Promise.reject(gone());
				asked = true;
				return background.promise;
			});
			server.emit({ type: "ended", session: ref, handle: h(ref) });
			const selections: Array<SessionRef | null> = [];
			controller.subscribe((next) => selections.push(next.state.selected));

			void controller.preview(otherRef);
			background.reject(gone());
			await settle();
			const clicking = controller.preview(thirdRef);
			await settle();
			clicks.get(sessionKey(thirdRef))!.resolve({ ref: thirdRef, turns: [previewAssistant("third")] });
			await clicking;

			expect(server.on["sessions/preview"].mock.calls.filter(([params]) => sessionKey(params.ref) === sessionKey(ref))).toHaveLength(1);
			expect(selections).not.toContain(null);
			expect(controller.getView().state.selected).toEqual(thirdRef);
			controller.dispose();
		});

		// The same, with the `connected` as the publish: the view dropped with
		// the stream, and the user clicked another row while the reconnect's
		// socket was opening, so the click's read is out behind its `hello`.
		it("asks no read of the dropped pane at the reconnect while a click made as the socket opened is out", async () => {
			const server = fakeServer();
			const otherRef: SessionRef = { backend: "codex", id: "thread-other" };
			const controller = createController(server.api());
			await controller.start();
			await controller.select(ref);
			await settle();
			server.drop();
			server.holdOpen = true;
			controller.reconnect();
			const clicked = deferred<SessionPreviewResponse>();
			server.on["sessions/preview"].mockClear();
			server.on["sessions/preview"].mockImplementation(async ({ ref: asked }) => {
				if (asked.id === otherRef.id) return clicked.promise;
				throw gone();
			});
			const selections: Array<SessionRef | null> = [];
			controller.subscribe((next) => selections.push(next.state.selected));

			const clicking = controller.preview(otherRef);
			server.open();
			await settle();
			clicked.resolve({ ref: otherRef, turns: [previewAssistant("other")] });
			await clicking;

			expect(server.on["sessions/preview"]).toHaveBeenCalledExactlyOnceWith({ ref: otherRef });
			expect(selections).not.toContain(null);
			expect(controller.getView().state.selected).toEqual(otherRef);
			controller.dispose();
		});

		// Only `gone` is an answer (OW-bilogo): no other code says the session
		// is nowhere, `not_found` included.
		for (const code of ["not_found", "internal_error"] as const) {
			it(`keeps the selection when a detached-loading pane's read fails ${code}`, async () => {
				const server = fakeServer();
				const controller = createController(server.api());
				await controller.start();
				await controller.select(ref);
				await settle();
				server.on["sessions/preview"].mockRejectedValue(new ApiClientError(code, "not an answer"));

				server.emit({ type: "ended", session: ref, handle: h(ref) });
				await settle();

				expect(controller.getView().state.selected).toEqual(ref);
				expect(paneMode(controller.getView())).toBe("loading");
				expect(controller.getView().previewFailure).toEqual({ ref, message: "not an answer" });
				controller.dispose();
			});

			it(`keeps the preview on screen when its poll fails ${code}`, async () => {
				vi.useFakeTimers();
				try {
					const server = fakeServer();
					const turns = [previewAssistant("stored")];
					server.on["sessions/preview"].mockResolvedValue({ ref, turns });
					const controller = createController(server.api());
					await controller.start();
					await controller.preview(ref);
					server.on["sessions/preview"].mockRejectedValue(new ApiClientError(code, "not an answer"));

					await vi.advanceTimersByTimeAsync(16_000);

					expect(controller.getView().state.selected).toEqual(ref);
					expect(controller.getView().preview).toEqual({ ref, turns });
					controller.dispose();
				} finally {
					vi.useRealTimers();
				}
			});
		}
	});
});
