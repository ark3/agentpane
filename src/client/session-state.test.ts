import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentRequest,
	type SessionRef,
	type SessionSummary,
	sessionKey,
} from "$shared/protocol.ts";
import {
	clearSessionError,
	initialClientState,
	reduceServerEvent,
	type ClientState,
} from "./session-state.ts";

const ref: SessionRef = { backend: "pi", id: "session-a" };
const oldRef: SessionRef = { backend: "pi", id: "virtual-a" };
const newRef: SessionRef = { backend: "pi", id: "/sessions/a.jsonl" };

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
		seq,
		messages: [userMessage("before")],
		isStreaming: false,
		compaction: null,
	}).state;
}

describe("client session state", () => {
	it("starts with no summaries, selection, or session views", () => {
		expect(initialClientState()).toEqual({ summaries: [], selected: null, sessions: {} });
	});

	it("replaces a transcript and resets sequence on snapshot", () => {
		const result = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			seq: 7,
			messages: [userMessage("hi")],
			isStreaming: true,
			compaction: null,
		});

		expect(result.state.sessions[sessionKey(ref)]).toMatchObject({
			seq: 7,
			messages: [userMessage("hi")],
			isStreaming: true,
			compaction: null,
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
			seq: 5,
			isStreaming: false,
			compaction: null,
		});

		expect(result.state).toBe(state);
		expect(result.recover).toEqual([ref]);
		expect(result.refreshSessions).toBe(false);
	});

	it("re-keys selected state atomically on renamed", () => {
		const result = reduceServerEvent(stateAtSequence(oldRef, 2), {
			type: "renamed",
			from: oldRef,
			session: newRef,
			seq: 3,
		});

		expect(result.state.selected).toEqual(newRef);
		expect(result.state.sessions[sessionKey(oldRef)]).toBeUndefined();
		expect(result.state.sessions[sessionKey(newRef)]?.seq).toBe(3);
		expect(result.state.sessions[sessionKey(newRef)]?.ref).toEqual(newRef);
		expect(result.recover).toEqual([]);
	});

	it("appends an upsert at the transcript tail", () => {
		const first = userMessage("first");
		const second = userMessage("second");
		const state = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			seq: 1,
			messages: [first],
			isStreaming: true,
			compaction: null,
		}).state;

		const result = reduceServerEvent(state, {
			type: "upsert",
			session: ref,
			seq: 2,
			index: 1,
			message: second,
		});

		expect(result.state.sessions[sessionKey(ref)]?.messages).toEqual([first, second]);
	});

	it("replaces an upsert at an existing transcript index", () => {
		const first = userMessage("first");
		const replacement = userMessage("replacement");
		const state = reduceServerEvent(stateWithSelected(ref), {
			type: "snapshot",
			session: ref,
			seq: 1,
			messages: [first],
			isStreaming: true,
			compaction: null,
		}).state;

		const result = reduceServerEvent(state, {
			type: "upsert",
			session: ref,
			seq: 2,
			index: 0,
			message: replacement,
		});

		expect(result.state.sessions[sessionKey(ref)]?.messages).toEqual([replacement]);
	});

	it("accepts the first sequenced event for a session without a snapshot", () => {
		const result = reduceServerEvent(initialClientState(), {
			type: "status",
			session: ref,
			seq: 4,
			isStreaming: true,
			compaction: null,
		});

		expect(result.state.sessions[sessionKey(ref)]).toMatchObject({
			ref,
			seq: 4,
			isStreaming: true,
			compaction: null,
			messages: [],
		});
		expect(result.recover).toEqual([]);
	});

	it("updates only the session-scoped streaming status", () => {
		const state = reduceServerEvent(stateAtSequence(ref, 3), {
			type: "status",
			session: ref,
			seq: 4,
			isStreaming: true,
			compaction: null,
		}).state;
		const result = reduceServerEvent(state, {
			type: "status",
			session: ref,
			seq: 5,
			isStreaming: false,
			compaction: null,
		});

		expect(result.state.sessions[sessionKey(ref)]).toMatchObject({ seq: 5, isStreaming: false });
		expect(result.state.sessions[sessionKey(ref)]?.messages).toEqual([userMessage("before")]);
	});

	it("stores an error on only its session", () => {
		const other = { backend: "codex", id: "session-b" } satisfies SessionRef;
		const state = stateAtSequence(ref, 1);
		const withOther = reduceServerEvent(state, {
			type: "snapshot",
			session: other,
			seq: 1,
			messages: [],
			isStreaming: false,
			compaction: null,
		}).state;
		const result = reduceServerEvent(withOther, {
			type: "error",
			session: ref,
			seq: 2,
			message: "turn failed",
		});

		expect(result.state.sessions[sessionKey(ref)]?.error).toBe("turn failed");
		expect(result.state.sessions[sessionKey(other)]?.error).toBeNull();
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
			seq: 2,
			request,
		});

		expect(result.state.sessions[sessionKey(ref)]?.requests).toEqual([request]);
	});

	it("clears a session's persisted error and leaves an unaffected session's state untouched (OW-31)", () => {
		const withError = reduceServerEvent(stateAtSequence(ref, 1), {
			type: "error",
			session: ref,
			seq: 2,
			message: "turn failed",
		}).state;

		const cleared = clearSessionError(withError, ref);

		expect(cleared.sessions[sessionKey(ref)]?.error).toBeNull();
		expect(clearSessionError(withError, { backend: "codex", id: "no-such-session" })).toBe(withError);
	});

	it("requests a session summary refresh when sessions change", () => {
		const state = initialClientState();
		const result = reduceServerEvent(state, { type: "sessions-changed" });

		expect(result.state).toBe(state);
		expect(result.recover).toEqual([]);
		expect(result.refreshSessions).toBe(true);
	});
});
