import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentRequest,
	type SessionRef,
	type SessionSummary,
} from "$shared/protocol.ts";
import {
	clearSessionError,
	handleOf,
	initialClientState,
	reduceServerEvent,
	type ClientState,
} from "./session-state.ts";

const ref: SessionRef = { backend: "pi", id: "session-a" };
const oldRef: SessionRef = { backend: "pi", id: "virtual-a" };
const newRef: SessionRef = { backend: "pi", id: "/sessions/a.jsonl" };

/** The handle the server minted for a session, opaque to the client (D24). `oldRef` and `newRef` are one session. */
function h(session: SessionRef): string {
	return session === newRef ? h(oldRef) : `handle-${session.backend}-${session.id}`;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function summary(session: SessionRef): SessionSummary {
	return {
		ref: session,
		cwd: "/work",
		preview: null,
		createdAt: null,
		updatedAt: null,
		status: "attached",
		isStreaming: false,
		onDisk: true,
	};
}

function stateWithSelected(session: SessionRef): ClientState {
	return {
		summaries: [summary(session)],
		selected: session,
		sessions: {},
	};
}

function stateAtSequence(session: SessionRef, seq: number): ClientState {
	const state = stateWithSelected(session);
	return reduceServerEvent(state, {
		type: "snapshot",
		session,
		handle: h(session),
		seq,
		messages: [userMessage("before")],
		isStreaming: false,
		compaction: null,
		model: null,
		effort: null,
		unrestoredModel: null,
		error: null,
		requests: [],
		notices: [],
	}).state;
}

describe("client session state", () => {
	it("replaces a prior model with an authoritative null snapshot", () => {
		const withModel = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 1,
			messages: [],
			isStreaming: false,
			compaction: null,
			model: "opaque/current",
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		}).state;

		const result = reduceServerEvent(withModel, {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 2,
			messages: [],
			isStreaming: false,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		});

		expect(result.state.sessions[h(ref)]?.model).toBeNull();
	});

	it("starts with no summaries, selection, or session views", () => {
		expect(initialClientState()).toEqual({ summaries: [], selected: null, sessions: {} });
	});

	it("replaces a transcript and resets sequence on snapshot", () => {
		const result = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 7,
			messages: [userMessage("hi")],
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		});

		expect(result.state.sessions[h(ref)]).toMatchObject({
			seq: 7,
			messages: [userMessage("hi")],
			isStreaming: true,
			compaction: null,
			model: null,
			error: null,
			requests: [],
		});
		expect(result.recover).toEqual([]);
		expect(result.refreshSessions).toBe(false);
	});

	it("requests recovery instead of applying an event after a sequence gap", () => {
		const state = stateAtSequence(ref, 3);
		const result = reduceServerEvent(state, {
			type: "status",
			session: ref,
			handle: h(ref),
			seq: 5,
			isStreaming: false,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
		});

		expect(result.state).toBe(state);
		expect(result.recover).toEqual([{ ref, handle: h(ref) }]);
		expect(result.refreshSessions).toBe(false);
	});

	// What the handle fixes is the `renamed` that never arrived -- one dropped
	// while the stream was down (D21), or one a late stream never carried -- so
	// these stage the new ref on an ordinary event under the same handle, with
	// no `renamed` before it (D24, OW-kimaya).
	it("takes a new ref from a status under a known handle, and the selection and its summary follow", () => {
		const result = reduceServerEvent(stateAtSequence(oldRef, 2), {
			type: "status",
			session: newRef,
			handle: h(oldRef),
			seq: 3,
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
		});

		expect(result.state.selected).toEqual(newRef);
		expect(result.state.summaries.map((item) => item.ref)).toEqual([newRef]);
		expect(Object.keys(result.state.sessions)).toEqual([h(oldRef)]);
		expect(result.state.sessions[h(oldRef)]).toMatchObject({ ref: newRef, seq: 3, isStreaming: true, messages: [userMessage("before")] });
		expect(result.recover).toEqual([]);
	});

	it("takes a new ref from the snapshot a reconnect sends under a known handle (D21)", () => {
		const other: SessionRef = { backend: "codex", id: "session-b" };
		const state = { ...stateAtSequence(oldRef, 2), summaries: [summary(oldRef), summary(other)] };
		const result = reduceServerEvent(state, {
			type: "snapshot",
			session: newRef,
			handle: h(oldRef),
			seq: 7,
			messages: [userMessage("before"), userMessage("after")],
			isStreaming: false,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		});

		expect(result.state.selected).toEqual(newRef);
		expect(result.state.summaries.map((item) => item.ref)).toEqual([newRef, other]);
		expect(Object.keys(result.state.sessions)).toEqual([h(oldRef)]);
		expect(result.state.sessions[h(oldRef)]).toMatchObject({ ref: newRef, seq: 7 });
	});

	it("moves nothing on renamed, which names the handle every view is already keyed by", () => {
		const state = stateAtSequence(oldRef, 2);
		const result = reduceServerEvent(state, { type: "renamed", from: oldRef, session: newRef, handle: h(oldRef), seq: 3 });

		expect(result.state).toBe(state);
		expect(result.recover).toEqual([]);
	});

	it("finds a ref's handle through the view carrying it, else the summary carrying it, and none for a preview", () => {
		const live = stateAtSequence(ref, 1);
		expect(handleOf(live, ref)).toBe(h(ref));

		const attachedOnly: ClientState = { ...stateWithSelected(ref), summaries: [{ ...summary(ref), handle: h(ref) }] };
		expect(handleOf(attachedOnly, ref)).toBe(h(ref));

		expect(handleOf(stateWithSelected(ref), ref)).toBeUndefined();
		expect(handleOf(live, null)).toBeUndefined();
	});

	it("appends an upsert at the transcript tail", () => {
		const first = userMessage("first");
		const second = userMessage("second");
		const state = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 1,
			messages: [first],
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		}).state;

		const result = reduceServerEvent(state, {
			type: "upsert",
			session: ref,
			handle: h(ref),
			seq: 2,
			index: 1,
			message: second,
		});

		expect(result.state.sessions[h(ref)]?.messages).toEqual([first, second]);
	});

	it("replaces an upsert at an existing transcript index", () => {
		const first = userMessage("first");
		const replacement = userMessage("replacement");
		const state = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 1,
			messages: [first],
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		}).state;

		const result = reduceServerEvent(state, {
			type: "upsert",
			session: ref,
			handle: h(ref),
			seq: 2,
			index: 0,
			message: replacement,
		});

		expect(result.state.sessions[h(ref)]?.messages).toEqual([replacement]);
	});

	it("ignores a status event for a session it holds no view of, rather than resurrecting one (OW-pezazo)", () => {
		const state = initialClientState();
		const result = reduceServerEvent(state, {
			type: "status",
			session: ref,
			handle: h(ref),
			seq: 4,
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
		});

		expect(result.state.sessions[h(ref)]).toBeUndefined();
		expect(result.state).toBe(state);
		// No recovery either: this client dropped the view on purpose, and an
		// attach here is the re-spawn OW-sugome exists to prevent.
		expect(result.recover).toEqual([]);
	});

	it("updates only the session-scoped streaming status", () => {
		const state = reduceServerEvent(stateAtSequence(ref, 3), {
			type: "status",
			session: ref,
			handle: h(ref),
			seq: 4,
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
		}).state;
		const result = reduceServerEvent(state, {
			type: "status",
			session: ref,
			handle: h(ref),
			seq: 5,
			isStreaming: false,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
		});

		expect(result.state.sessions[h(ref)]).toMatchObject({ seq: 5, isStreaming: false });
		expect(result.state.sessions[h(ref)]?.messages).toEqual([userMessage("before")]);
	});

	it("stores an error on only its session", () => {
		const other = { backend: "codex", id: "session-b" } satisfies SessionRef;
		const state = stateAtSequence(ref, 1);
		const withOther = reduceServerEvent(state, {
			type: "snapshot",
			session: other,
			handle: h(other),
			seq: 1,
			messages: [],
			isStreaming: false,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
		}).state;
		const result = reduceServerEvent(withOther, {
			type: "error",
			session: ref,
			handle: h(ref),
			seq: 2,
			message: "turn failed",
		});

		expect(result.state.sessions[h(ref)]?.error).toBe("turn failed");
		expect(result.state.sessions[h(other)]?.error).toBeNull();
	});

	it("keeps a notice on its session and leaves the session's error as it was (OW-tujiya)", () => {
		const notice = { kind: "warning", message: "fallback metadata", details: null, path: null };
		const failed = reduceServerEvent(stateAtSequence(ref, 1), {
			type: "error",
			session: ref,
			handle: h(ref),
			seq: 2,
			message: "turn failed",
		}).state;

		const noticed = reduceServerEvent(failed, { type: "notice", session: ref, handle: h(ref), seq: 3, notice }).state;

		expect(noticed.sessions[h(ref)]?.notices).toEqual([notice]);
		expect(noticed.sessions[h(ref)]?.error).toBe("turn failed");

		const second = { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml:3:5" };
		const both = reduceServerEvent(noticed, { type: "notice", session: ref, handle: h(ref), seq: 4, notice: second }).state;
		expect(both.sessions[h(ref)]?.notices).toEqual([notice, second]);

		// A clean session's error stays null: a notice is not an error.
		const clean = reduceServerEvent(stateAtSequence(ref, 1), { type: "notice", session: ref, handle: h(ref), seq: 2, notice }).state;
		expect(clean.sessions[h(ref)]?.error).toBeNull();
		// Nor does clearing the error, as the next prompt does (OW-31), clear the notice.
		expect(clearSessionError(both, h(ref)).sessions[h(ref)]?.notices).toEqual([notice, second]);
	});

	it("retains a pending request for its session", () => {
		const request: AgentRequest = {
			requestId: "request-1",
			session: ref,
			kind: "approval",
			payload: { path: "README.md" },
		};
		const result = reduceServerEvent(stateAtSequence(ref, 1), {
			type: "request",
			session: ref,
			handle: h(ref),
			seq: 2,
			request,
		});

		expect(result.state.sessions[h(ref)]?.requests).toEqual([request]);
	});

	it("drops a request the server retracts, keeping the others (OW-gusifo)", () => {
		const resolved: AgentRequest = { requestId: "request-1", session: ref, kind: "approval", payload: {} };
		const pending: AgentRequest = { requestId: "request-2", session: ref, kind: "elicitation", payload: {} };
		let state = reduceServerEvent(stateAtSequence(ref, 1), { type: "request", session: ref, handle: h(ref), seq: 2, request: resolved }).state;
		state = reduceServerEvent(state, { type: "request", session: ref, handle: h(ref), seq: 3, request: pending }).state;

		const result = reduceServerEvent(state, { type: "request-resolved", session: ref, handle: h(ref), seq: 4, requestId: "request-1" });

		expect(result.state.sessions[h(ref)]?.requests).toEqual([pending]);
		expect(result.recover).toEqual([]);
	});

	it("clears a session's persisted error and leaves an unaffected session's state untouched (OW-31)", () => {
		const withError = reduceServerEvent(stateAtSequence(ref, 1), {
			type: "error",
			session: ref,
			handle: h(ref),
			seq: 2,
			message: "turn failed",
		}).state;

		const cleared = clearSessionError(withError, h(ref));

		expect(cleared.sessions[h(ref)]?.error).toBeNull();
		expect(clearSessionError(withError, "no-such-handle")).toBe(withError);
	});

	it("takes a session's error, requests and notices from a snapshot, replacing what it held (OW-bipume)", () => {
		const request: AgentRequest = { requestId: "request-1", session: ref, kind: "approval", payload: {} };
		const held = { kind: "warning", message: "fallback metadata", details: null, path: null };
		let state = stateAtSequence(ref, 1);
		state = reduceServerEvent(state, { type: "error", session: ref, handle: h(ref), seq: 2, message: "turn failed" }).state;
		state = reduceServerEvent(state, { type: "request", session: ref, handle: h(ref), seq: 3, request }).state;
		state = reduceServerEvent(state, { type: "notice", session: ref, handle: h(ref), seq: 4, notice: held }).state;

		const later = { kind: "configWarning", message: "unknown key", details: null, path: null };
		const snapshot = reduceServerEvent(state, {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 0,
			messages: [],
			isStreaming: false,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: null,
			requests: [],
			notices: [held, later],
		}).state;

		expect(snapshot.sessions[h(ref)]).toMatchObject({ error: null, requests: [], notices: [held, later] });

		// And a view the snapshot creates starts from what the server holds.
		const fresh = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			handle: h(ref),
			seq: 3,
			messages: [],
			isStreaming: true,
			compaction: null,
			model: null,
			effort: null,
			unrestoredModel: null,
			error: "turn failed",
			requests: [request],
			notices: [held],
		}).state;
		expect(fresh.sessions[h(ref)]).toMatchObject({ error: "turn failed", requests: [request], notices: [held] });
	});

	it("requests a session summary refresh when sessions change", () => {
		const state = initialClientState();
		const result = reduceServerEvent(state, { type: "sessions-changed" });

		expect(result.state).toBe(state);
		expect(result.recover).toEqual([]);
		expect(result.refreshSessions).toBe(true);
	});
});
