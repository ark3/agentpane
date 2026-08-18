import { describe, expect, it, vi } from "vitest";
import type {
	BackendId,
	ServerEvent,
	SessionPreviewResponse,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
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
	readonly preview = vi.fn(
		async (session: SessionRef): Promise<SessionPreviewResponse> => ({ ref: session, turns: [] }),
	);
	readonly prompt = vi.fn(async (_session: SessionRef, _body: { text: string }) => {});
	readonly abort = vi.fn(async (_session: SessionRef) => {});
	readonly compact = vi.fn(async (_session: SessionRef) => {});
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

	it("previews a stored session read-only, selecting it without attaching or spawning", async () => {
		const api = new FakeApi();
		api.preview.mockResolvedValue({ ref, turns: [{ role: "user", text: "hi" }] });
		const controller = createController(api);

		await controller.preview(ref);

		expect(api.preview).toHaveBeenCalledWith(ref);
		expect(api.attach).not.toHaveBeenCalled();
		expect(controller.getView().preview).toEqual({ ref, turns: [{ role: "user", text: "hi" }] });
		expect(controller.getView().state.selected).toEqual(ref);
	});

	it("reselects an already-attached session live instead of re-fetching a stale preview", async () => {
		const api = new FakeApi();
		api.attach.mockResolvedValue(summary(attachedRef));
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		// The snapshot a real attach produces gives this client live state for it.
		api.emit({ type: "snapshot", session: attachedRef, seq: 1, messages: [], isStreaming: false });
		expect(controller.getView().state.selected).toEqual(attachedRef);
		api.preview.mockClear();

		await controller.preview(attachedRef);

		expect(api.preview).not.toHaveBeenCalled();
		expect(controller.getView().state.selected).toEqual(attachedRef);
		expect(controller.getView().preview).toBeNull();
	});

	it("clears the read-only preview once the session is attached", async () => {
		const api = new FakeApi();
		api.preview.mockResolvedValue({ ref, turns: [{ role: "user", text: "hi" }] });
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
		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: false });
		api.emit({ type: "error", session: ref, seq: 2, message: "The turn ended in an error." });
		expect(controller.getView().state.sessions["pi:virtual-a"]?.error).toBe("The turn ended in an error.");

		controller.setDraft("try again");
		await controller.submit();

		expect(controller.getView().state.sessions["pi:virtual-a"]?.error).toBeNull();
	});

	it("clears the persisted error on the session's new key when a rename lands mid-submit (D9)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: false });
		api.emit({ type: "error", session: ref, seq: 2, message: "Stale error from a prior turn." });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// The session renames (virtual -> real) while the prompt is still in flight.
		const renamed: SessionRef = { backend: "pi", id: "/sessions/renamed.jsonl" };
		api.emit({ type: "renamed", from: ref, session: renamed, seq: 3 });
		prompt.resolve();
		await submitted;

		expect(controller.getView().state.sessions["pi:/sessions/renamed.jsonl"]?.error).toBeNull();
	});

	it("does not clear a fresh same-turn error that races in via SSE before the prompt POST resolves (D2)", async () => {
		const api = new FakeApi();
		const prompt = deferred<void>();
		api.prompt.mockReturnValue(prompt.promise);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: false });

		controller.setDraft("try again");
		const submitted = controller.submit();

		// A genuine error for *this* turn arrives before the POST's own response does.
		api.emit({ type: "error", session: ref, seq: 2, message: "This turn just failed." });
		prompt.resolve();
		await submitted;

		expect(controller.getView().state.sessions["pi:virtual-a"]?.error).toBe("This turn just failed.");
	});

	it("dismisses the view error and the selected session's persisted error", async () => {
		const api = new FakeApi();
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: false });
		api.emit({ type: "error", session: ref, seq: 2, message: "The turn ended in an error." });

		controller.clearError();

		expect(controller.getView().error).toBeNull();
		expect(controller.getView().state.sessions["pi:virtual-a"]?.error).toBeNull();
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
