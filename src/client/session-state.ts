import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentRequest,
	type ServerEvent,
	type SessionRef,
	type SessionSummary,
	sessionKey,
} from "$shared/protocol.ts";

export interface SessionView {
	ref: SessionRef;
	messages: AgentMessage[];
	isStreaming: boolean;
	compaction?: "requesting" | "running" | null;
	seq: number | null;
	error: string | null;
	requests: AgentRequest[];
}

export interface ClientState {
	summaries: SessionSummary[];
	selected: SessionRef | null;
	sessions: Record<string, SessionView>;
}

export interface ReduceResult {
	state: ClientState;
	recover: SessionRef[];
	refreshSessions: boolean;
}

export function initialClientState(): ClientState {
	return { summaries: [], selected: null, sessions: {} };
}

function emptySession(ref: SessionRef): SessionView {
	return {
		ref,
		messages: [],
		isStreaming: false,
		compaction: null,
		seq: null,
		error: null,
		requests: [],
	};
}

function result(state: ClientState, recover: SessionRef[] = [], refreshSessions = false): ReduceResult {
	return { state, recover, refreshSessions };
}

function sameRef(left: SessionRef | null, right: SessionRef): boolean {
	return left?.backend === right.backend && left.id === right.id;
}

function acceptsSequence(view: SessionView | undefined, seq: number): boolean {
	return view?.seq === null || view?.seq === undefined || seq === view.seq + 1;
}

function updateSession(state: ClientState, view: SessionView): ClientState {
	return { ...state, sessions: { ...state.sessions, [sessionKey(view.ref)]: view } };
}

/** Clear a session's persisted turn error, e.g. after the next prompt succeeds (OW-31). */
export function clearSessionError(state: ClientState, ref: SessionRef): ClientState {
	const view = state.sessions[sessionKey(ref)];
	if (!view || view.error === null) return state;
	return updateSession(state, { ...view, error: null });
}

export function reduceServerEvent(state: ClientState, event: ServerEvent): ReduceResult {
	if (event.type === "sessions-changed") return result(state, [], true);

	if (event.type === "snapshot") {
		const key = sessionKey(event.session);
		const previous = state.sessions[key];
		const view: SessionView = {
			...(previous ?? emptySession(event.session)),
			ref: event.session,
			messages: [...event.messages],
			isStreaming: event.isStreaming,
			compaction: event.compaction,
			seq: event.seq,
		};
		return result(updateSession(state, view));
	}

	if (event.type === "renamed") {
		const fromKey = sessionKey(event.from);
		const toKey = sessionKey(event.session);
		const previous = state.sessions[fromKey] ?? state.sessions[toKey];
		if (!acceptsSequence(previous, event.seq)) return result(state, [event.from]);

		const renamed: SessionView = {
			...(previous ?? emptySession(event.session)),
			ref: event.session,
			seq: event.seq,
		};
		const sessions = { ...state.sessions };
		delete sessions[fromKey];
		sessions[toKey] = renamed;
		const summaries = state.summaries.map((summary) =>
			sameRef(summary.ref, event.from) ? { ...summary, ref: event.session } : summary,
		);
		return result({
			...state,
			summaries,
			selected: sameRef(state.selected, event.from) ? event.session : state.selected,
			sessions,
		});
	}

	const key = sessionKey(event.session);
	const previous = state.sessions[key];
	if (!acceptsSequence(previous, event.seq)) return result(state, [event.session]);

	const view: SessionView = {
		...(previous ?? emptySession(event.session)),
		ref: event.session,
		seq: event.seq,
	};

	switch (event.type) {
		case "upsert": {
			const messages = [...view.messages];
			if (event.index === messages.length) messages.push(event.message);
			else if (event.index >= 0 && event.index < messages.length) messages[event.index] = event.message;
			else return result(state);
			view.messages = messages;
			break;
		}
		case "status":
			view.isStreaming = event.isStreaming;
			view.compaction = event.compaction;
			break;
		case "error":
			view.error = event.message;
			break;
		case "request":
			view.requests = [...view.requests, event.request];
			break;
	}

	return result(updateSession(state, view));
}
