import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentNotice,
	type LiveStatus,
	type ServerEvent,
	type SessionRef,
	type SessionSummary,
	liveStatusOf,
	sessionKey,
} from "$shared/protocol.ts";

export interface SessionView extends LiveStatus {
	ref: SessionRef;
	messages: AgentMessage[];
	seq: number | null;
	error: string | null;
	/**
	 * The wire's `errorId` for `error`, null exactly when `error` is: what a
	 * dismissal and a prompt name the error by (OW-jokoto).
	 */
	errorId: string | null;
	/**
	 * The backend's non-fatal notices, oldest first (OW-tujiya). Kept apart
	 * from `error` on purpose: nothing that clears an error clears these. Like
	 * `error`, every `snapshot` carries the server's copy and the
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
	 * since `detach()`, `sessions/preview` and every row comparison read refs.
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
 * The handle of the live view a ref names (D24), or undefined for a preview
 * or a stored row. Views alone answer: an attach's reply follows its
 * snapshot on the socket (D31 point 3), so no window is left in which a
 * reply knows a handle the stream has not brought.
 */
export function handleOf(state: ClientState, ref: SessionRef | null): string | undefined {
	if (ref === null) return undefined;
	for (const [handle, view] of Object.entries(state.sessions)) if (sameRef(view.ref, ref)) return handle;
	return undefined;
}

/** The live view a ref names, found through its handle; undefined for a preview. */
export function viewOf(state: ClientState, ref: SessionRef | null): SessionView | undefined {
	const handle = handleOf(state, ref);
	return handle === undefined ? undefined : state.sessions[handle];
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
 * the preview read of a dropped view, which goes by the selected ref, where
 * an old `virtual:` id reads `gone`, whatever the new ref has on disk
 * (OW-vasubu, D26 point 5, D35 point 1).
 *
 * With no view before the event -- a snapshot introducing one -- the old ref
 * is the one the summary carrying the handle holds, which a listing put
 * there: a reconnect's opening snapshot of a session renamed during the
 * outage (`onDisconnect` in `controller.ts`). That is the only case that
 * reads the summaries, so a streaming token under an unchanged ref costs
 * nothing here.
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

/** Clear a session's persisted turn error, as a dismissal does (`clearError` in `controller.ts`). */
export function clearSessionError(state: ClientState, handle: string): ClientState {
	const view = state.sessions[handle];
	if (!view || view.error === null) return state;
	return updateSession(state, handle, { ...view, error: null, errorId: null });
}

export function reduceServerEvent(state: ClientState, event: ServerEvent): ReduceResult {
	if (event.type === "sessions-changed") return result(state, [], true);

	// The server let go of the handle, and nothing comes under it again (D26).
	// Before the sequence check below, since it carries no seq: whatever the
	// view's count stands at, it has nothing left to wait for. The selection is
	// the consumer's; the browser's pane falls to the preview.
	if (event.type === "ended") {
		if (state.sessions[event.handle] === undefined) return result(state);
		const sessions = { ...state.sessions };
		delete sessions[event.handle];
		return result({ ...state, sessions });
	}

	if (event.type === "snapshot") {
		const previous = state.sessions[event.handle];
		const view: SessionView = {
			ref: event.session,
			messages: [...event.messages],
			...liveStatusOf(event),
			seq: event.seq,
			error: event.error,
			errorId: event.errorId,
			notices: [...event.notices],
		};
		return result(
			followRef(updateSession(state, event.handle, view), event.handle, previous, event.session),
		);
	}

	// From here on the arms only *update* a view; none of them may create one
	// (OW-pezazo). Creating was resurrecting sessions this client had deliberately
	// dropped: `detach` in `controller.ts` once removed the live view itself while
	// events for it were still on the wire -- `broadcaster.forget` only stops the
	// counter, it cannot recall what has been fanned out -- and a late `status`
	// rebuilt the entry, re-lighting the session list's streaming dot on a dead
	// row until the next re-list healed it. The view now goes on `ended`, the
	// last event under its handle (D26), but a gap still drops one whose handle
	// goes on streaming (`Recovery`), and this is what keeps that one dropped.
	//
	// A snapshot is how the server introduces a session to a client --
	// `sendOpeningSnapshots` on connect for every live ref, and `broadcastSnapshot`
	// on both branches of `attach` (`session-manager.ts`) -- so the `snapshot` arm
	// above is the one that must create, and does.
	//
	// The four arms the adapter drives are not, however, unreachable before that introduction, and what
	// they drop there is worth naming. `#start` subscribes `onUpdate`,
	// `onError` and `onNotice` before it awaits
	// `adapter.start(...)`, and the `"fork"` a Pi adapter announces moves it onto a
	// container of the fork's, under a new handle, naming nothing under the
	// parent's (`#forkOnto`, D20, D24, OW-suhoto), so all four can fan out under a handle no client holds
	// a view of until the fork's hydrate or its attach snapshots it. None of that
	// is lost:
	// the snapshot that follows carries `messages`, `isStreaming`, `compaction` and
	// `model` wholesale, and since OW-bipume the session's `error` and
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
			Object.assign(view, liveStatusOf(event));
			break;
		case "error":
			view.error = event.message;
			view.errorId = event.errorId;
			break;
		case "error-cleared":
			view.error = null;
			view.errorId = null;
			break;
		case "notice":
			view.notices = [...view.notices, event.notice];
			break;
	}

	return result(followRef(updateSession(state, event.handle, view), event.handle, previous, event.session));
}
