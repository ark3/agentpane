import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentNotice,
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
	effort: string | null;
	/** The wire's `unrestoredModel`: a recorded model the backend could not restore (OW-jitoni). */
	unrestoredModel?: string | null;
	seq: number | null;
	error: string | null;
	requests: AgentRequest[];
	/**
	 * The backend's non-fatal notices, oldest first (OW-tujiya). Kept apart
	 * from `error` on purpose: nothing that clears an error clears these, and
	 * like `error` and `requests` no snapshot carries them.
	 */
	notices: AgentNotice[];
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
		effort: null,
		seq: null,
		error: null,
		requests: [],
		notices: [],
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
			effort: event.effort,
			unrestoredModel: event.unrestoredModel,
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

	// From here on the arms only *update* a view; none of them may create one
	// (OW-pezazo). Creating was resurrecting sessions this client had deliberately
	// dropped: `detach` in `controller.ts` removes the live view while events for
	// it are still on the wire -- `broadcaster.forget` only stops the counter, it
	// cannot recall what has been fanned out -- and a late `status` rebuilt the
	// entry, re-lighting the session list's streaming dot on a dead row until the
	// next re-list healed it.
	//
	// A snapshot is how the server introduces a session to a client --
	// `sendOpeningSnapshots` on connect for every live ref, and `broadcastSnapshot`
	// on both branches of `attach` (`session-manager.ts`) -- so the `snapshot` arm
	// above is the one that must create, and does. `renamed` keeps its own creation
	// too: it is followed immediately by `broadcastSnapshot(to)` (`broadcaster.ts`),
	// so the entry it builds is filled a moment later rather than left hollow.
	//
	// These four arms are not, however, unreachable before that introduction, and
	// what they drop there is worth naming. `#start` subscribes `onUpdate`,
	// `onRequest` and `onError` before it awaits `adapter.start(...)`, and
	// `#adoptRef(session, "fork")` re-keys a live Pi container onto the fork's ref
	// with no snapshot behind it (D20, OW-suhoto), so all four can fan out under a
	// key no client holds a view of. For `upsert` and `status` that costs nothing:
	// the snapshot that follows carries `messages`, `isStreaming`, `compaction` and
	// `model` wholesale. For `error` and `requests` it is a real loss, because no
	// snapshot carries either field -- but that loss is the pre-existing one, not a
	// new class: neither field survives an SSE reconnect or reaches a client that
	// connects later, and `AttachSessionResponse` does not carry them either. Closing
	// it means putting them in the snapshot or publishing the adapter earlier, on the
	// server (OW-bipume); it does not mean letting an event resurrect a dead view
	// here, which costs more than it buys -- a resurrecting `error` lights the alert
	// banner over a session the user just detached, where the `status` above only
	// lit a dot.
	//
	// Ignoring is silent on purpose: no recovery is requested either. A recovery
	// here would `api.attach` the session and spawn the subprocess again behind
	// the user, which is the defect OW-sugome closed from the other side.
	const key = sessionKey(event.session);
	const previous = state.sessions[key];
	if (previous === undefined) return result(state);
	if (!acceptsSequence(previous, event.seq)) return result(state, [event.session]);

	const view: SessionView = {
		...previous,
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
			view.effort = event.effort;
			view.unrestoredModel = event.unrestoredModel;
			break;
		case "error":
			view.error = event.message;
			break;
		case "request":
			view.requests = [...view.requests, event.request];
			break;
		case "notice":
			view.notices = [...view.notices, event.notice];
			break;
	}

	return result(updateSession(state, view));
}
