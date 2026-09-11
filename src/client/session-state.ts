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
	model: string | null;
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

/** Replace the disk listing and forget unchanged live views the server now reports as closed. */
export function replaceSessionSummaries(
	state: ClientState,
	summaries: SessionSummary[],
	sessionsWhenListed: Readonly<Record<string, SessionView>>,
): ClientState {
	let sessions = state.sessions;
	let nextSummaries = summaries;
	for (const [index, summary] of summaries.entries()) {
		const key = sessionKey(summary.ref);
		const listedView = sessionsWhenListed[key];
		const currentView = sessions[key];
		if (summary.status !== "detached") continue;
		if (currentView !== undefined && currentView !== listedView) {
			const current = state.summaries.find((item) => sessionKey(item.ref) === key);
			if (current !== undefined) {
				if (nextSummaries === summaries) nextSummaries = [...summaries];
				nextSummaries[index] = current;
			}
			continue;
		}
		if (listedView === undefined) continue;
		if (sessions === state.sessions) sessions = { ...sessions };
		delete sessions[key];
	}
	return { ...state, summaries: nextSummaries, sessions };
}

function emptySession(ref: SessionRef): SessionView {
	return {
		ref,
		messages: [],
		isStreaming: false,
		compaction: null,
		model: null,
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

/**
 * Write the client's own view of a session's compaction phase (OW-natiha):
 * "requesting" at the request itself, since the server's own "requesting"
 * status races the POST response (D2), and null again if that request fails.
 * Server events overwrite this; the reducer above stays wire-truth only.
 *
 * Sharing one field with the wire is deliberate, and it buys two races, both
 * weighed and accepted on 2026-09-11 (OW-husivu, declined):
 *
 *  - A `status` or `snapshot` carrying `null` lands in the window before the
 *    server's own "requesting" and wipes a fresh mark. This client's POST is
 *    what makes the server write "requesting", so the healing event is already
 *    in flight.
 *  - A rejected POST clears a "requesting" that is another client's wire truth
 *    (`compact()` in `controller.ts`). Nothing heals this one: the rejection
 *    changed no server state, and `#onUpdate` broadcasts only what moved. The
 *    mark returns when the *other* client's compaction advances to "running".
 *
 * What that costs is not cosmetic. This field gates Send and Compact
 * (`App.svelte`, `send()` and the two `disabled=` conditions), so a wrongly
 * cleared mark re-opens them while a compaction is genuinely running, and the
 * prompt is refused by the backend. Accepted anyway: both races need a second
 * client driving the same session, and the alternative is a client-only phase
 * every reducer arm has to be taught to leave alone. A second optimistic mark
 * in the composer would bring the same defect with it, and is what would
 * reopen this.
 */
export function setSessionCompaction(
	state: ClientState,
	ref: SessionRef,
	compaction: "requesting" | null,
): ClientState {
	const view = state.sessions[sessionKey(ref)] ?? emptySession(ref);
	if (view.compaction === compaction) return state;
	return updateSession(state, { ...view, compaction });
}

export function reduceServerEvent(state: ClientState, event: ServerEvent): ReduceResult {
	if (event.type === "sessions-changed") return result(state, [], true);

	if (event.type === "snapshot") {
		// This and the `status` arm below both overwrite `compaction`, which may
		// be holding a click-time mark rather than wire truth. Overwriting it is
		// the contract -- see `setSessionCompaction` for the two races that buys
		// and why they were accepted (OW-husivu).
		const key = sessionKey(event.session);
		const previous = state.sessions[key];
		const view: SessionView = {
			...(previous ?? emptySession(event.session)),
			ref: event.session,
			messages: [...event.messages],
			isStreaming: event.isStreaming,
			compaction: event.compaction,
			model: event.model,
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
			view.model = event.model;
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
