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
	 * from `error` on purpose: nothing that clears an error clears these. Like
	 * `error` and `requests`, every `snapshot` carries the server's copy and the
	 * snapshot arm takes it (OW-bipume); the Emacs helper reads them from here
	 * onto its own `session/snapshot`.
	 */
	notices: AgentNotice[];
}

export interface ClientState {
	summaries: SessionSummary[];
	/**
	 * The row the user chose, previews included, so a ref and not a handle: a
	 * stored session being previewed has no handle (D24). A live view is found
	 * from it through `handleOf`. It follows the ref: an event under a handle
	 * that names a new `session` moves this where it named the view's old ref,
	 * since `detach()`, the preview route and every row comparison read refs.
	 */
	selected: SessionRef | null;
	/**
	 * Live views, keyed by the handle the server minted for each (D24,
	 * OW-kimaya). A rename moves a view's `ref` and never its key, so nothing
	 * keyed by the handle has anything to re-key.
	 */
	sessions: Record<string, SessionView>;
}

/** A session whose `seq` gapped: re-attach it by `ref`, and key the attempt by `handle`. */
export interface Recovery {
	ref: SessionRef;
	handle: string;
}

export interface ReduceResult {
	state: ClientState;
	recover: Recovery[];
	refreshSessions: boolean;
}

export function initialClientState(): ClientState {
	return { summaries: [], selected: null, sessions: {} };
}

function sameRef(left: SessionRef | null, right: SessionRef): boolean {
	return left?.backend === right.backend && left.id === right.id;
}

/**
 * The handle of the live session a ref names (D24): the view carrying that
 * ref, else the summary carrying it. The summary is the only holder in the
 * window after an attach reply lands and before its snapshot does; a preview
 * or a stored row has neither, and answers undefined.
 */
export function handleOf(state: ClientState, ref: SessionRef | null): string | undefined {
	if (ref === null) return undefined;
	for (const [handle, view] of Object.entries(state.sessions)) if (sameRef(view.ref, ref)) return handle;
	return state.summaries.find((summary) => summary.handle !== undefined && sameRef(summary.ref, ref))?.handle;
}

/** The live view a ref names, found through its handle; undefined for a preview. */
export function viewOf(state: ClientState, ref: SessionRef | null): SessionView | undefined {
	const handle = handleOf(state, ref);
	return handle === undefined ? undefined : state.sessions[handle];
}

/** Each view's current ref -> its handle. */
function handlesByRef(sessions: Readonly<Record<string, SessionView>>): Map<string, string> {
	const byRef = new Map<string, string>();
	for (const [handle, view] of Object.entries(sessions)) byRef.set(sessionKey(view.ref), handle);
	return byRef;
}

/**
 * Replace the disk listing and forget unchanged live views the server now
 * reports as closed.
 *
 * A listed summary pairs with a view by ref, not by handle: `list()` gives a
 * summary a handle only for a container still in the server's table, so a
 * session closed since carries none, and that summary is exactly the one
 * whose view goes. Paired, the view is evicted only if it is the very object
 * that stood when the listing was asked for; a view an event has touched
 * since is newer than the listing, which keeps it and the summary it had
 * (OW-fihuma).
 */
export function replaceSessionSummaries(
	state: ClientState,
	summaries: SessionSummary[],
	sessionsWhenListed: Readonly<Record<string, SessionView>>,
): ClientState {
	const listedHandles = handlesByRef(sessionsWhenListed);
	const currentHandles = handlesByRef(state.sessions);
	let sessions = state.sessions;
	let nextSummaries = summaries;
	for (const [index, summary] of summaries.entries()) {
		if (summary.status !== "detached") continue;
		const key = sessionKey(summary.ref);
		const handle = listedHandles.get(key) ?? currentHandles.get(key);
		if (handle === undefined) continue;
		const listedView = sessionsWhenListed[handle];
		const currentView = sessions[handle];
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
		delete sessions[handle];
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

function result(state: ClientState, recover: Recovery[] = [], refreshSessions = false): ReduceResult {
	return { state, recover, refreshSessions };
}

function acceptsSequence(view: SessionView | undefined, seq: number): boolean {
	return view?.seq === null || view?.seq === undefined || seq === view.seq + 1;
}

function updateSession(state: ClientState, handle: string, view: SessionView): ClientState {
	return { ...state, sessions: { ...state.sessions, [handle]: view } };
}

/**
 * The ref is an attribute of the view (D24): an event under a handle whose
 * `session` is not the ref the view held has moved it, whether or not a
 * `renamed` reached this client first -- one missed while the stream was down
 * (D21), or one a late stream never carried. The summary carrying the handle
 * or the old ref, and `selected` where it named the old ref, move with it,
 * because they are compared by ref: `aria-pressed`, `selectedSummary`, and
 * `detach()`, which finds the `onDisk` summary by ref and previews by ref,
 * where an old `virtual:` id reads an empty transcript (OW-vasubu).
 *
 * With no view before the event -- a snapshot introducing one -- the old ref
 * is the one the summary carrying the handle holds, which an attach reply put
 * there before the snapshot landed. That is the only case that reads the
 * summaries, so a streaming token under an unchanged ref costs nothing here.
 */
function followRef(state: ClientState, handle: string, previous: SessionView | undefined, to: SessionRef): ClientState {
	const from = previous?.ref ?? state.summaries.find((summary) => summary.handle === handle)?.ref;
	if (from === undefined || sameRef(from, to)) return state;
	return {
		...state,
		summaries: state.summaries.map((summary) =>
			summary.handle === handle || sameRef(summary.ref, from) ? { ...summary, ref: to } : summary,
		),
		selected: sameRef(state.selected, from) ? to : state.selected,
	};
}

/**
 * A ref names at most one live session: the server maps each name to one
 * handle (`#names` in `session-manager.ts`), so a snapshot introducing `ref`
 * under `handle` means any other handle this client holds for it names a
 * session the server has let go -- detached and attached again by another
 * client, say, with a new handle minted, while this tab's stream was down or
 * before its re-list. That view is dropped here, at the one arm that
 * introduces views, which owns the rule; it is not a guard at a read site.
 * Left standing, `handleOf` answered the old handle and the pane showed a
 * frozen transcript while the new one's upserts landed unseen (OW-kimaya).
 */
function withoutOtherViewsOf(state: ClientState, ref: SessionRef, handle: string): ClientState {
	let sessions: Record<string, SessionView> | undefined;
	for (const [other, view] of Object.entries(state.sessions)) {
		if (other === handle || !sameRef(view.ref, ref)) continue;
		sessions ??= { ...state.sessions };
		delete sessions[other];
	}
	return sessions === undefined ? state : { ...state, sessions };
}

/** Clear a session's persisted turn error, e.g. after the next prompt succeeds (OW-31). */
export function clearSessionError(state: ClientState, handle: string): ClientState {
	const view = state.sessions[handle];
	if (!view || view.error === null) return state;
	return updateSession(state, handle, { ...view, error: null });
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
 *
 * It writes only a view that exists (OW-kimaya). Compact is enabled on
 * `selected !== null`, so the click can land before any snapshot has
 * introduced the view: on a preview, or between an attach reply and its
 * snapshot. This used to create `emptySession(ref)` there, under the ref it
 * was keyed by; keyed by the handle, a preview has none to key it by, and a
 * view made from the summary's handle would be the one view no snapshot
 * introduced (OW-pezazo). The mark is skipped instead, and the snapshot that
 * introduces the view carries the server's own `compaction`.
 */
export function setSessionCompaction(
	state: ClientState,
	handle: string,
	compaction: "requesting" | null,
): ClientState {
	const view = state.sessions[handle];
	if (view === undefined || view.compaction === compaction) return state;
	return updateSession(state, handle, { ...view, compaction });
}

export function reduceServerEvent(state: ClientState, event: ServerEvent): ReduceResult {
	if (event.type === "sessions-changed") return result(state, [], true);

	if (event.type === "snapshot") {
		// This and the `status` arm below both overwrite `compaction`, which may
		// be holding a click-time mark rather than wire truth. Overwriting it is
		// the contract -- see `setSessionCompaction` for the two races that buys
		// and why they were accepted (OW-husivu).
		const previous = state.sessions[event.handle];
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
			error: event.error,
			requests: [...event.requests],
			notices: [...event.notices],
		};
		return result(
			followRef(updateSession(withoutOtherViewsOf(state, event.session, event.handle), event.handle, view), event.handle, previous, event.session),
		);
	}

	// A no-op, kept only until OW-mofuho takes the event off the wire. The
	// handle it carries is the one the view is already keyed by, and the
	// snapshot `Broadcaster.renamed` sends straight after it carries the new
	// ref, which the arm above writes like any other attribute. Its `seq` is
	// not counted here; that snapshot resets the count (D3).
	if (event.type === "renamed") return result(state);

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
	// above is the one that must create, and does.
	//
	// These six arms are not, however, unreachable before that introduction, and what
	// they drop there is worth naming. `#start` subscribes `onUpdate`, `onRequest`,
	// `onError`, `onNotice` and `onRequestResolved` before it awaits
	// `adapter.start(...)`, and the `"fork"` a Pi adapter announces moves it onto a
	// container of the fork's, under a new handle, with no `renamed` (`#forkOnto`,
	// D20, D24, OW-suhoto), so all six can fan out under a handle no client holds
	// a view of until the fork's hydrate or its attach snapshots it. None of that
	// is lost:
	// the snapshot that follows carries `messages`, `isStreaming`, `compaction` and
	// `model` wholesale, and since OW-bipume the session's `error`, `requests` and
	// `notices` too, which the server holds for exactly this -- and for the client
	// that reconnects or connects later, which never saw the event at all. What the
	// snapshot carries is the only restoring path a client has, which is why the fix
	// lives there and not in letting an event resurrect a dead view here: that costs
	// more than it buys -- a resurrecting `error` lights the alert banner over a
	// session the user just detached, where the `status` above only lit a dot.
	//
	// Ignoring is silent on purpose: no recovery is requested either. A recovery
	// here would `api.attach` the session and spawn the subprocess again behind
	// the user, which is the defect OW-sugome closed from the other side.
	const previous = state.sessions[event.handle];
	if (previous === undefined) return result(state);
	if (!acceptsSequence(previous, event.seq)) return result(state, [{ ref: event.session, handle: event.handle }]);

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
		case "request-resolved":
			view.requests = view.requests.filter((request) => request.requestId !== event.requestId);
			break;
		case "notice":
			view.notices = [...view.notices, event.notice];
			break;
	}

	return result(followRef(updateSession(state, event.handle, view), event.handle, previous, event.session));
}
