import { describe, expect, it, vi } from "vitest";
import type { BackendId, ServerEvent, SessionRef, SessionSummary } from "$shared/protocol.ts";
import type { AgentpaneApi, EventConnection, EventHandlers } from "./api.ts";
import { createController } from "./controller.ts";

const ref: SessionRef = { backend: "pi", id: "virtual-a" };
const attachedRef: SessionRef = { backend: "pi", id: "/sessions/a.jsonl" };

function summary(session: SessionRef, cwd = "/work"): SessionSummary {
	return {
		ref: session,
		cwd,
		preview: null,
		createdAt: null,
		updatedAt: null,
		status: "attached",
		isStreaming: false,
	};
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
	readonly prompt = vi.fn(async (_session: SessionRef, _body: { text: string }) => {});
	readonly abort = vi.fn(async (_session: SessionRef) => {});
	readonly listSessions = vi.fn(async (_cwd?: string) => [summary(ref)]);
	readonly connection: EventConnection = { close: vi.fn() };
	handlers: EventHandlers | undefined;

	connect(handlers: EventHandlers): EventConnection {
		this.handlers = handlers;
		return this.connection;
	}

	emit(event: ServerEvent): void {
		this.handlers?.onEvent(event);
	}
}

describe("client controller", () => {
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

	it("keeps the latest selection when earlier and later attaches resolve out of order", async () => {
		const api = new FakeApi();
		const firstRef: SessionRef = { backend: "pi", id: "/sessions/first.jsonl" };
		const secondRef: SessionRef = { backend: "codex", id: "thread-second" };
		const first = deferred<SessionSummary>();
		const second = deferred<SessionSummary>();
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

	it("clears the draft only after the prompt is accepted", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("send me");

		await controller.submit();

		expect(api.prompt).toHaveBeenCalledWith(ref, { text: "send me" });
		expect(controller.getView().draft).toBe("");
	});

	it("aborts the current authoritative selected ref", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);
		await controller.select(ref);

		await controller.abort();

		expect(api.abort).toHaveBeenCalledWith(attachedRef);
	});

	it("updates selection on renamed before a following snapshot", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };

		api.emit({ type: "renamed", from: ref, session: renamed, seq: 1 });
		api.emit({ type: "snapshot", session: renamed, seq: 2, messages: [], isStreaming: false });

		expect(controller.getView().state.selected).toEqual(renamed);
		expect(controller.getView().state.sessions["pi:/sessions/renamed.jsonl"]?.seq).toBe(2);
	});

	it("coalesces recovery attaches while a sequence-gap recovery is in flight", async () => {
		const api = new FakeApi();
		const recovery = deferred<SessionSummary>();
		api.attach.mockImplementationOnce(async (session) => summary(session)).mockImplementationOnce(() => recovery.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: false });

		api.emit({ type: "status", session: ref, seq: 3, isStreaming: true });
		api.emit({ type: "status", session: ref, seq: 3, isStreaming: true });

		expect(api.attach).toHaveBeenCalledTimes(2);
		recovery.resolve(summary(ref));
		await recovery.promise;
	});

	it("does not select an unrelated session while recovering it", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();

		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: false });
		api.emit({ type: "status", session: ref, seq: 3, isStreaming: true });
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

	it("refreshes the new workspace while startup listing is in flight without applying its stale result", async () => {
		const api = new FakeApi();
		const allSessions = deferred<SessionSummary[]>();
		const workspaceSessions = deferred<SessionSummary[]>();
		const scopedRef: SessionRef = { backend: "codex", id: "workspace-session" };
		api.listSessions.mockImplementationOnce(() => allSessions.promise).mockImplementationOnce(() => workspaceSessions.promise);
		const controller = createController(api);

		const starting = controller.start();
		const selectingWorkspace = controller.setWorkspace("/work/project");

		expect(api.listSessions).toHaveBeenNthCalledWith(1, undefined);
		expect(api.listSessions).toHaveBeenNthCalledWith(2, "/work/project");
		workspaceSessions.resolve([summary(scopedRef, "/work/project")]);
		await selectingWorkspace;
		allSessions.resolve([summary(ref)]);
		await starting;

		expect(controller.getView().state.summaries).toEqual([summary(scopedRef, "/work/project")]);
	});

	it("rejects relative workspace input before listing or creating a session", async () => {
		const api = new FakeApi();
		const controller = createController(api);

		await controller.setWorkspace("work/project");
		await controller.create("work/project", "pi");

		expect(api.listSessions).not.toHaveBeenCalled();
		expect(api.createSession).not.toHaveBeenCalled();
		expect(controller.getView().error).toBe("Workspace must be an absolute path.");
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
});
