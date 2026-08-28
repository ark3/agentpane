import { describe, expect, it, vi } from "vitest";
import type {
	BackendId,
	ForkPoint,
	ForkRequest,
	ServerEvent,
	SessionPreviewResponse,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";
import type { AgentpaneApi, EventConnection, EventHandlers } from "./api.ts";
import { createController } from "./controller.ts";

const ref: SessionRef = { backend: "pi", id: "virtual-a" };
const attachedRef: SessionRef = { backend: "pi", id: "/sessions/a.jsonl" };
/** A Codex-shaped fork: a brand-new thread this client is not driving yet. */
const forkedRef: SessionRef = { backend: "codex", id: "thread-forked" };

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
	readonly forkPoints = vi.fn(async (_session: SessionRef): Promise<ForkPoint[]> => []);
	readonly fork = vi.fn(async (_session: SessionRef, _body: ForkRequest) => forkedRef);
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

	/**
	 * OW-hezidi. The fork point is addressed by *ordinal* among user messages --
	 * `GET fork-points` returns one point per user message in transcript order --
	 * so identical wording in two messages cannot confuse it.
	 */
	it("forks at the ordinal-th user message and only then prompts, into the ref the fork returned (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([
			{ id: "turn-1", text: "same words" },
			{ id: "turn-2", text: "same words" },
			{ id: "turn-3", text: "same words" },
		]);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("reworded");

		await controller.forkAndSubmit(1);

		expect(api.forkPoints).toHaveBeenCalledWith(ref);
		expect(api.fork).toHaveBeenCalledWith(ref, { entryId: "turn-2" });
		expect(api.prompt).toHaveBeenCalledWith(forkedRef, { text: "reworded" });
		// Order, not just occurrence: prompting the parent and then forking would
		// leave the edited turn on the session the edit was supposed to spare.
		expect(api.fork.mock.invocationCallOrder[0]!).toBeLessThan(api.prompt.mock.invocationCallOrder[0]!);
		expect(controller.getView().draft).toBe("");
	});

	it("ends selected and attached to a Codex-shaped fork, which renames nothing (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first" }]);
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

	it("stops a running turn before forking it (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first" }]);
		const controller = createController(api);
		await controller.start();
		await controller.select(ref);
		api.emit({ type: "snapshot", session: ref, seq: 1, messages: [], isStreaming: true });
		controller.setDraft("reworded");

		await controller.forkAndSubmit(0);

		expect(api.abort).toHaveBeenCalledWith(ref);
		expect(api.abort.mock.invocationCallOrder[0]!).toBeLessThan(api.fork.mock.invocationCallOrder[0]!);
	});

	it("keeps the draft, and reports, when there is no fork point at that ordinal (OW-hezidi)", async () => {
		const api = new FakeApi();
		api.forkPoints.mockResolvedValue([{ id: "turn-1", text: "first" }]);
		const controller = createController(api);
		await controller.select(ref);
		controller.setDraft("reworded");

		expect(await controller.forkAndSubmit(4)).toBe(false);

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
