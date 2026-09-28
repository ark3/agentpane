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
	/**
	 * The wire's `errorId` for `error`, null exactly when `error` is: what a
	 * dismissal and a prompt name the error by (OW-jokoto).
	 */
	errorId: string | null;
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

/**
 * A session whose `seq` gapped, under `handle` and at the gapped event's
 * `ref`. Each consumer detaches it, attaching nothing (D25 point 5):
 * `detachGapped` in `controller.ts` for the browser, and in
 * `src/emacs/helper.ts` for the Emacs helper.
 */
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
		errorId: null,
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
 * `session` is not the ref the view held has moved it, and that is all a
 * rename is on the wire: the server sends a snapshot under the handle
 * carrying the new ref and nothing else (OW-mofuho), and one lost to a
 * dropped stream (D21) is made good by the reconnect's opening snapshot,
 * which carries the current ref under the same handle. The summary carrying
 * the handle or the old ref, and `selected` where it named the old ref, move with it,
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

/** Clear a session's persisted turn error, as a dismissal does (`clearError` in `controller.ts`). */
export function clearSessionError(state: ClientState, handle: string): ClientState {
	const view = state.sessions[handle];
	if (!view || view.error === null) return state;
	return updateSession(state, handle, { ...view, error: null, errorId: null });
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
 * It writes only a view that exists (OW-kimaya), and creates none: a view
 * made here would be the one view no snapshot introduced (OW-pezazo). Its one
 * caller, `compact()` in `controller.ts`, acts only on a live pane since
 * OW-forinu, so a view stands at the click; a click on a preview or between
 * an attach reply and its snapshot, which this once had to skip, is refused
 * before it gets here. A view gone by the time a failed request comes back
 * to clear its mark -- a gap, a drop or a listing can take it meanwhile -- is
 * caught by that caller, which reads the mark through the view first, so no
 * caller reaches the check today; it stays as this function's own contract.
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
			errorId: event.errorId,
			requests: [...event.requests],
			notices: [...event.notices],
		};
		return result(
			followRef(updateSession(withoutOtherViewsOf(state, event.session, event.handle), event.handle, view), event.handle, previous, event.session),
		);
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
	// above is the one that must create, and does.
	//
	// The six arms the adapter drives are not, however, unreachable before that introduction, and what
	// they drop there is worth naming. `#start` subscribes `onUpdate`, `onRequest`,
	// `onError`, `onNotice` and `onRequestResolved` before it awaits
	// `adapter.start(...)`, and the `"fork"` a Pi adapter announces moves it onto a
	// container of the fork's, under a new handle, naming nothing under the
	// parent's (`#forkOnto`, D20, D24, OW-suhoto), so all six can fan out under a handle no client holds
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
	// Ignoring is silent on purpose: no gap is reported either, since there is
	// no view to detach.
	const previous = state.sessions[event.handle];
	if (previous === undefined) return result(state);
	// A gap applies nothing and is reported for the consumer to answer: the
	// browser and the helper each detach that one session (see `Recovery`). A
	// snapshot never gaps -- it restarts the count, which is why its arm above
	// makes no check.
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
			view.errorId = event.errorId;
			break;
		case "error-cleared":
			view.error = null;
			view.errorId = null;
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
