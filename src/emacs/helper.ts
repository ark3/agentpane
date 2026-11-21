/**
 * The Emacs helper's loop (OW-refibu): JSON-RPC requests in over stdio, each
 * a thin call through the api client, on the one socket it holds to the
 * server (D31); the server's events fed through the browser's own reducer,
 * and what the buffer needs pushed back out as notifications. The method
 * names and payloads are `protocol.ts`.
 *
 * Testable in node: `main.ts` is only the Bun binding, and everything with
 * behaviour takes its input and output as injectable streams beside
 * `openSocket`, the token and the markdown renderer. `bun run test` runs vitest under
 * node, where `Bun.stdin` is undefined, which is why the split exists.
 *
 * What the reducer decides and what this loop decides. `reduceServerEvent`
 * applies every rule the browser learned -- key a live view by its handle and
 * take a new ref from any event under it (D24), report a `seq` gap, ignore an
 * event for a view it does not hold (D2) -- and answers
 * `{ state, recover, refreshSessions }` and nothing more, so
 * the loop dispatches on the raw event's `type` beside that result. A `seq`
 * gap detaches that one session, as the browser's does (D25 point 5): its
 * view goes, and Emacs is told `session/detached` under its handle where a
 * view was bound to it, and nothing is attached on its behalf (`detachGapped` below).
 *
 * One socket, filtered. It opens as the first request for a known method is
 * read, and stays open until the helper exits; a request read before it has opened goes out
 * behind its `hello`. Not at the helper's start: with no server listening,
 * the failed open would end the helper before it read the request Emacs had
 * already written, which would then get no reply, where it is owed one
 * saying the server could not be reached (OW-pezelo). Replies and events arrive on it in the order the server wrote
 * them, and a command's reply follows everything it caused (D31 point 3):
 * an attach's reply follows the snapshot it broadcast, and a listing's reply
 * is ordered against the `sessions-changed` around it (OW-nufafi). The
 * server sends an opening snapshot for every live session and broadcasts
 * every event to every client, so views Emacs never attached form in the
 * reducer too; notifications go out only for a handle a view of Emacs's is
 * bound to. `sessions/changed` and `session/turnEnded` are unfiltered.
 *
 * Views (D32 points 1 and 2). Each transcript buffer is a view, named by an
 * integer agentpane-mode mints when it makes the buffer and never changes,
 * and every per-session request names its view. The helper holds each
 * view's binding, the handle it is attached under, in `views`, with at most
 * one view per handle, and sends every per-session notification under the
 * view bound to its handle, carrying `view` beside `handle` (D24,
 * OW-suyinu). It stores no ref: requests carry `session`, and a fresh
 * helper knows no views. A binding is made when the snapshot that answers
 * an attach goes out to the view that sent it, and at nothing else
 * (OW-rebawa): the reply only ends the request (`bind` below). It goes at
 * the view's `sessions/detach`, at the server's `ended` under the handle
 * (`end`), and at a `seq` gap (`detachGapped`), each of which Emacs is told
 * of but the detach; a listing drops nothing. So agentpane-mode sends no
 * handle, and the helper fills it in from the binding for every request on
 * a live session, refusing one from a view bound to nothing `not_attached`,
 * as the server refuses an ended handle (D31 point 9). A binding also
 * changes at an `ended` or a gap, which reach the helper on their own, so a
 * prompt sent while the buffer held a handle carries `live`, and is refused
 * rather than sent by ref once the binding has gone: by ref it would resume
 * the session another client closed (D30). An attach from one view that
 * lands on a handle another view holds binds nothing, and its reply names
 * the holder, for agentpane-mode to show (D32 point 2); no buffers merge.
 * Until D32 agentpane-mode minted a token per attach, and the helper held
 * a claim per token on each handle (OW-wukako, OW-nowihu).
 *
 * Requests still out (D32 point 4). The helper holds each view's requests
 * still out, as the browser's controller holds its own (`Outstanding` in
 * `src/client/controller.ts`), and applies the browser's rules and no
 * others. A second send from a view, a prompt or a fork and prompt, is
 * refused `busy` (`sendsOut`), and so is one, or a second compact, while
 * a compact from the view is out (`compactsOut`), as the browser's
 * `compacting` holds Send and Compact from the click to the reply; the
 * server's status reporting the compaction covers the rest, which
 * agentpane-mode reads itself. A second attach from a view joins its first
 * attach, create or by-ref prompt still out, sending the server nothing
 * and answering as that one does (`attachesOut`). A prompt from an unbound
 * view whose attach is out waits for it and goes under the handle it
 * bound, or is refused, never sent by ref. While a fork and prompt is out,
 * an attach or a by-ref prompt of the session it forks is refused
 * `forking`, from any view (`forksOut`), since on Pi it would resume the
 * parent's old branch (D30). agentpane-mode keeps its own record of its
 * send, refusing a second before it reaches this one, as the browser keeps
 * `submit`'s guard beside its own; until ark3/agentpane#71 it held its
 * attach's waiters, its close in flight and its fork and prompt in flight
 * itself.
 *
 * Turn ends (D32 point 6). The helper hosts the browser's turn-done watch,
 * `watchSubmit`, `watchAbandon`, `watchSessions` and `watchClose` from
 * `src/client/favicon.ts`, with no focus, keyed by handle (`turnWatch`),
 * and the level half of its row marks, `foldSessionTurns` in
 * `src/client/session-turns.ts`, as the last `isStreaming` seen under each
 * live session's handle (`levels`). The selection that function reads and
 * the marks it keeps are agentpane-mode's, which knows what windows show.
 * After every event that changes the reducer's state, a session whose level
 * falls from true to false is sent `session/turnEnded`, whether or not a
 * view of Emacs's is bound to it, `watched` where the watch on its handle
 * ended there (`foldTurns`). A send arms the watch only where none stands,
 * from the session's level as it goes, so a steer into a running turn
 * raises; a server refusal or a `handled` disposition abandons it only
 * where that send armed it, as the browser's `disarmSubmit` does, and an
 * outcome unknown, the connection lost or a throw of the helper's own,
 * never does (`arm`). A prompt from a bound view arms at receipt; one by
 * ref, or one that waited on its view's attach, arms under the handle the
 * attach landed on, which may be another view's (D32 point 2); one the
 * helper refuses itself arms nothing. A fork and prompt arms the fork's
 * handle at its reply, unless handled, and with `stops` abandons the
 * parent's as it goes out, as the browser reads `stopsBeforeFork`.
 * `unwatch` on `sessions/abort` and on `sessions/fork` abandons the view's
 * watch before the request goes out, for agentpane-mode's plain Pi fork,
 * until ark3/agentpane#17 retires it.
 * A view's detach, a gap and a close's reply abandon the watch on the
 * handle, raising nothing (D25 point 5); the server's `ended` raises a
 * watch that has seen streaming, which the browser leaves waiting, a
 * difference D32 point 6 records. At a socket close each watch that has
 * seen streaming is raised before the helper exits (D31 point 6); at the
 * input's end, as at `agentpane-shutdown`, nothing is (D25 point 4).
 * Until D32 agentpane-mode kept the watch per handle with a claim per
 * prompt (OW-kakasu), and read the levels from its picker's listings.
 *
 * The helper does not reconnect: when the socket closes, or fails to open,
 * the helper exits (D25 point 4, D31 point 6). Agentpane is local-only, so a close means the
 * server went away, and there is nothing to reconnect to. agentpane-mode takes the exit to mean every
 * buffer the helper served is detached, and the next command that needs a
 * helper starts a new one (`agentpane--helper-gone` and
 * `agentpane--connection` in emacs/agentpane.el).
 *
 * Nodes are throttled (OW-jeruye). The server sends every streamed token as
 * an `upsert` carrying the whole message so far, about 34 a second on Haiku,
 * and rendering each one's node and Emacs redrawing it made agentpane-mode
 * lag. So an upsert is not rendered as it arrives but held, keyed by the
 * node it replaces -- for a tool result, its call's (`locateUpsert`) -- and
 * a later one for that node takes its place. What is held is rendered and
 * sent `NODE_INTERVAL_MS` after the first of it was held, and before
 * anything else the helper writes, any notification or reply for any
 * session. Each held node goes out in its last state but in the place of its
 * first upsert since the last send, so a new node is never drawn ahead of
 * one that came before it, which Emacs appends in arrival order. Emacs
 * relies on that order too: the status that ends streaming redraws the tail
 * from the node it holds, and a newly appended node redraws the one before
 * it. Every upsert waits, the first after a quiet spell too, which leaves
 * one timer and no second state to keep; a node goes out sooner only when a
 * write forces it. A held node is rendered from the transcript as it stood
 * at its upsert, not from the current state, which a later snapshot may have
 * rewound past it, so it is exactly the node the unthrottled stream would
 * have sent. A detach, an `ended` or a gap drops what is held under its handle, and the
 * end of the input drops everything held, so no timer keeps the process up
 * past it (OW-kofuda). A held node whose rendering throws is skipped and the
 * rest still go out (OW-vejeka): the send runs from the timer, where a throw
 * ends the process (measured on Bun 1.4.0), and from every other write,
 * where it would answer a request that succeeded with an error, or throw
 * out of the socket's handler from `onEvent`; and either way the nodes held
 * behind it would be lost.
 */

import { ApiClientError, ConnectionLostError, createAgentpaneApi, type ApiOptions, type EventHandlers } from "$client/api.ts";
import { emptyTurnWatch, watchAbandon, watchClose, watchSessions, watchSubmit, type TurnWatch } from "$client/favicon.ts";
import { previewMessages } from "$client/preview.ts";
import { initialClientState, reduceServerEvent, type ClientState, type SessionView } from "$client/session-state.ts";
import type { BackendId, ModelInfo, ServerEvent, SessionRef, SessionSummary } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { locateUpsert, projectTarget, projectTranscript, type Render, type UpsertTarget } from "./nodes.ts";
import type { HelperNotification, HelperRequests, TranscriptNode } from "./protocol.ts";
import type { ApiToken } from "./token.ts";

export interface HelperOptions {
	input: ReadableStream<Uint8Array>;
	write: (frame: Uint8Array) => void;
	openSocket: NonNullable<ApiOptions["openSocket"]>;
	/** Read once, for the `hello` (`token.ts`). */
	token: () => ApiToken;
	render: Render;
}

type Handlers = { [M in keyof HelperRequests]: (params: HelperRequests[M]["params"]) => Promise<HelperRequests[M]["result"]> };

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

/** The owner's first cut, 2026-09-25, to be judged by use (OW-jeruye). */
const NODE_INTERVAL_MS = 250;

/**
 * The JSON-RPC code of an error the server answered with, or the api client
 * raised for a request it never sent: agentpane-mode reads its `data`, which
 * carries the `error` code, and not this (`agentpane--request`).
 */
const REFUSED = -32000;

/** The integer agentpane-mode names a transcript buffer by (D32 point 1). */
type View = number;

/**
 * A request that attaches a session for `view` (OW-rebawa), not yet replied
 * to; `done` once its snapshot has gone out, or the view's detach gave it up.
 * `onLand`, where given, is told the handle it landed on, bound for the view
 * or held by another, as `bind` finds it (D32 point 6).
 */
interface Attaching {
	view: View;
	done: boolean;
	onLand?: (handle: string) => void;
}

/**
 * What the first attach still out from a view settled to, for a second
 * attach from the view that joins it and a prompt from the view that waits
 * on it (D32 point 4): the session its reply names, the view holding that
 * session where another does, and the handle it bound the view to, if any.
 */
interface Joined {
	summary: SessionSummary | undefined;
	holder: View | undefined;
	bound: string | undefined;
}

/**
 * A refusal naming a session it attached, or a fork, that another view holds
 * (D32 point 2): it goes out naming that view beside the session.
 */
class HeldElsewhere extends Error {
	constructor(
		readonly refusal: ApiClientError,
		readonly view: View,
	) {
		super(refusal.message);
	}
}

/** An upsert not yet sent: what `session/node` will say, short of the rendering. */
interface HeldNode {
	session: SessionRef;
	view: View;
	handle: string;
	target: UpsertTarget;
	isStreaming: boolean;
}

/**
 * Runs until `input` ends, or the socket closes or fails to open (D25 point
 * 4); then closes the socket and resolves. At a socket close, and not at
 * the input's end, each turn-done watch that has seen streaming is raised
 * first (D31 point 6; see the head of this file).
 *
 * A request still out when the socket closes gets no reply (OW-hiliti): the
 * api client settles it as the connection lost, which says nothing of
 * whether it reached the backend (D31 point 6), so agentpane-mode answers it
 * as the helper's death, and the echo area says the helper exited. That
 * holds whichever end closed it, the server going away or this helper
 * closing it as `input` ended. Nor does it abandon a turn-done watch its
 * prompt armed: only a refusal carrying the server's `error` code says a
 * request reached no backend (OW-zedawo), and the helper's own -32603 is
 * an outcome unknown too.
 *
 * A request that was never written is refused with a code of the api
 * client's own: `unreachable` for one read before a first open that failed,
 * or after the socket had closed; `frame_too_large` for one over the
 * server's limit; and at a close for a refused token, `unauthorized` for
 * each, with the token file named (`token.ts`), since the server ran
 * nothing. Those replies are chains of microtasks from the rejections, which
 * the api client settles before it reports the close, and are written
 * whenever they land: nothing silences a failure but the connection lost.
 * Until D31 a failed first open answered -32603, an outcome unknown, where
 * it is now the refusal it is (OW-pezelo).
 */
export async function runHelper(options: HelperOptions): Promise<void> {
	const { render } = options;
	/** What a refused `hello` says, from the read it went out with. */
	let refusal = "the server refused the API token";
	const api = createAgentpaneApi({
		openSocket: options.openSocket,
		token: () => {
			const token = options.token();
			refusal = token.refusal;
			return token.value;
		},
	});

	let state: ClientState = initialClientState();
	/** Each bound view -> the handle it is attached under, no handle under two views; see the head of this file. */
	const views = new Map<View, string>();
	const holderOf = (handle: string): View | undefined => {
		for (const [view, held] of views) if (held === handle) return view;
		return undefined;
	};
	/** Every request that attaches, not yet replied to; see `Attaching`. */
	const attaching = new Set<Attaching>();
	/** Each view's first attach, create or by-ref prompt still out, for a later attach to join and a prompt to wait on (D32 point 4). */
	const attachesOut = new Map<View, Promise<Joined>>();
	/** The views with a prompt or a fork and prompt still out, as the browser's one `"submitting"` (D32 point 4). */
	const sendsOut = new Set<View>();
	/** The views with a `sessions/compact` still out, as the browser's `"compacting"`: no send and no second compact goes from one meanwhile (D32 point 4). */
	const compactsOut = new Set<View>();
	/** The session each fork and prompt still out forks, by every ref it is known by: nothing attaches it meanwhile (D30, D32 point 4). */
	const forksOut = new Set<string[]>();
	const keyOf = (ref: SessionRef): string => JSON.stringify([ref.backend, ref.id]);
	/** The browser's turn-done watch, keyed by handle, its focus always false (D32 point 6). */
	let turnWatch: TurnWatch = emptyTurnWatch();
	/** Each live session's last `isStreaming`, by handle: the level half of the browser's row marks (`foldSessionTurns`). */
	const levels = new Map<string, boolean>();
	let stopped = false;
	const reader = options.input.getReader();
	/** Held nodes by handle and node index, in the order each was first held; a later upsert keeps its place. */
	const waiting = new Map<string, HeldNode>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushNodes = (): void => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		const nodes = [...waiting.values()];
		waiting.clear();
		for (const { session, view, handle, target, isStreaming } of nodes) {
			let node: TranscriptNode;
			try {
				node = projectTarget(target, isStreaming, render);
			} catch {
				continue;
			}
			const notification: HelperNotification = { method: "session/node", params: { session, view, handle, node } };
			options.write(encodeFrame({ jsonrpc: "2.0", ...notification }));
		}
	};

	/** Every write but a held node's goes after all of them. */
	const write = (frame: Uint8Array): void => {
		flushNodes();
		options.write(frame);
	};

	const notify = (notification: HelperNotification): void => {
		write(encodeFrame({ jsonrpc: "2.0", ...notification }));
	};

	/**
	 * Each backend's `models/list`, asked once, the first time a status or
	 * snapshot names a model on it, and held for the helper's life; `null`
	 * while it is out. A failed listing is forgotten, so the next status on
	 * the backend asks again.
	 */
	const listings = new Map<BackendId, ModelInfo[] | null>();

	/**
	 * The `defaultEffort` of `view`'s model, from its backend's listing (D32
	 * point 8), as the browser's effort select reads `ModelInfo.defaultEffort`;
	 * `null` until the listing has answered, and then each bound view's session
	 * on the backend whose model names one is sent a status carrying it.
	 */
	const defaultEffortOf = (view: SessionView): string | null => {
		if (view.model === null) return null;
		const { backend } = view.ref;
		if (!listings.has(backend) && !stopped) listModels(backend);
		return listings.get(backend)?.find((info) => info.id === view.model)?.defaultEffort ?? null;
	};

	const listModels = (backend: BackendId): void => {
		listings.set(backend, null);
		api.listModels(backend).then(
			(models) => {
				listings.set(backend, models);
				if (stopped) return;
				for (const [bound, handle] of views) {
					const view = state.sessions[handle];
					if (view?.ref.backend === backend && defaultEffortOf(view) !== null) {
						notify({ method: "session/status", params: statusOf(view, bound, handle) });
					}
				}
			},
			() => listings.delete(backend),
		);
	};

	const statusOf = (view: SessionView, bound: View, handle: string) => ({
		session: view.ref,
		view: bound,
		handle,
		isStreaming: view.isStreaming,
		compaction: view.compaction ?? null,
		model: view.model,
		effort: view.effort,
		defaultEffort: defaultEffortOf(view),
		unrestoredModel: view.unrestoredModel ?? null,
	});

	/** Send `view` to the view `bound` as a snapshot under `handle`. */
	const notifySnapshot = (view: SessionView, bound: View, handle: string): void => {
		notify({
			method: "session/snapshot",
			params: {
				...statusOf(view, bound, handle),
				nodes: projectTranscript(view.messages, view.isStreaming, render),
				error: view.error,
				errorId: view.errorId,
				notices: view.notices,
			},
		});
	};

	/**
	 * Answer `attach`, whose reply named `handle`, with the snapshot that
	 * binds its view, from the view the reducer holds under the handle;
	 * called as the reply is handled, and before it goes out. The reply
	 * follows the snapshot its command broadcast, so the view is there,
	 * unless something handled since took it: an `ended` or a gap under the
	 * handle, after which nothing is bound and the buffer is not attached,
	 * as it should not be (D25 point 5, D26). Nothing either for an attach the
	 * view's detach gave up while it was out. Where another view holds the
	 * handle, nothing is bound and that view is answered, for the reply to
	 * name (D32 point 2); where the view itself holds it, a `g` on an
	 * attached buffer, it is sent the snapshot again. A view bound to
	 * another handle moves to this one, dropping what was held for the old.
	 */
	const bind = (attach: Attaching, handle: string): View | undefined => {
		if (attach.done) return undefined;
		attach.done = true;
		const view = state.sessions[handle];
		if (!view) return undefined;
		attach.onLand?.(handle);
		const holder = holderOf(handle);
		if (holder !== undefined && holder !== attach.view) return holder;
		const old = views.get(attach.view);
		if (old !== undefined && old !== handle) dropHeld(old);
		views.set(attach.view, handle);
		notifySnapshot(view, attach.view, handle);
		return undefined;
	};

	/**
	 * Run `request`, an attach for `view`, binding the handle `handleOf`
	 * reads from its reply, or from its refusal where one names a session it
	 * attached (D30); answer the reply and the view holding that handle, if
	 * another does, and throw a refusal naming one as `HeldElsewhere`.
	 * With `joinable`, which reads the session from the reply, it is the
	 * view's attach still out until it settles, which a later attach from
	 * the view joins and a prompt from it waits on (`attachesOut`). With
	 * `onLand`, see `Attaching`.
	 */
	const attachingBy = <T>(
		view: View,
		request: () => Promise<T>,
		handleOf: (reply: T) => string | null | undefined,
		joinable?: (reply: T) => SessionSummary | undefined,
		onLand?: (handle: string) => void,
	): Promise<{ reply: T; holder: View | undefined }> => {
		const attach: Attaching = { view, done: false, onLand };
		attaching.add(attach);
		const run = (async () => {
			try {
				let reply: T;
				try {
					reply = await request();
				} catch (error: unknown) {
					const handle = error instanceof ApiClientError ? (error.attached?.handle ?? error.fork?.handle) : undefined;
					const holder = handle ? bind(attach, handle) : undefined;
					throw holder === undefined ? error : new HeldElsewhere(error as ApiClientError, holder);
				}
				const handle = handleOf(reply) ?? undefined;
				const holder = handle ? bind(attach, handle) : undefined;
				const bound = handle !== undefined && holder === undefined && views.get(view) === handle ? handle : undefined;
				return { reply, holder, bound };
			} finally {
				attaching.delete(attach);
			}
		})();
		if (joinable) {
			const joined = run.then(({ reply, holder, bound }) => ({ summary: joinable(reply), holder, bound }));
			attachesOut.set(view, joined);
			const forget = () => {
				if (attachesOut.get(view) === joined) attachesOut.delete(view);
			};
			joined.then(forget, forget);
		}
		return run;
	};

	/**
	 * Refuse a send from `view` while one is out, or while a compact from it
	 * is, `busy`, as the browser's `submit` and `send` refuse one (OW-nasofa,
	 * OW-natiha): the backends cannot safely admit a turn beside a compaction,
	 * and the server's status saying one runs comes only with the compact's
	 * reply.
	 */
	const refuseBusy = (view: View): void => {
		if (sendsOut.has(view)) throw new ApiClientError("busy", "a prompt from this buffer is still being sent");
		if (compactsOut.has(view)) throw new ApiClientError("busy", "a compaction requested from this buffer has not answered");
	};

	/** Refuse what would attach `session` while a fork and prompt of it is out, `forking` (D30): on Pi it would resume the parent's old branch. */
	const refuseForking = (session: SessionRef): void => {
		const key = keyOf(session);
		for (const keys of forksOut) if (keys.includes(key)) throw new ApiClientError("forking", "a fork of this session is in flight");
	};

	/** Run `send` as `view`'s send still out, after refusing one already out. */
	const sending = async <T>(view: View, send: () => Promise<T>): Promise<T> => {
		refuseBusy(view);
		sendsOut.add(view);
		try {
			return await send();
		} finally {
			sendsOut.delete(view);
		}
	};

	/** `reply` with `view` beside it, where another view holds what it names. */
	const naming = <T extends object>(reply: T, holder: View | undefined): T | (T & { view: View }) => (holder === undefined ? reply : { ...reply, view: holder });

	/** The handle `view` is bound to, or a refusal `not_attached`, as the server refuses an ended handle (D31 point 9). */
	const liveHandle = (view: View): string => {
		const handle = views.get(view);
		if (handle === undefined) throw new ApiClientError("not_attached", "no live session is attached to this buffer");
		return handle;
	};

	/**
	 * Arm the turn-done watch on `handle` for a send, from the session's
	 * level now, unless one already stands there, and answer whether this
	 * send armed it: only then may its disarm take it down, as the
	 * browser's `armBadge` answers (OW-zikiga). A session streaming as the
	 * send goes is running the turn the send joins, a steer, whose end
	 * raises though no further `isStreaming: true` comes, as the browser's
	 * fork arms from its level.
	 */
	const arm = (handle: string): boolean => {
		if (turnWatch.waiting.has(handle)) return false;
		turnWatch = watchSubmit(turnWatch, handle, state.sessions[handle]?.isStreaming === true);
		return true;
	};

	/** Drop the turn-done watch on `handle`, if any, raising nothing. */
	const unwatch = (handle: string | undefined): void => {
		if (handle !== undefined) turnWatch = watchAbandon(turnWatch, handle);
	};

	/** Tell Emacs the turn under `handle` ended, naming the view bound to it, if any. */
	const turnEnded = (handle: string, session: SessionRef, watched: boolean): void => {
		const bound = holderOf(handle);
		notify({ method: "session/turnEnded", params: { session, handle, watched, ...(bound === undefined ? {} : { view: bound }) } });
	};

	/**
	 * Fold the reducer's state into the levels and the watch, after an event
	 * that changed it, and send `session/turnEnded` for each session whose
	 * level fell from true to false, `watched` where `watchSessions` ended
	 * the watch on its handle. A false that follows no true ends nothing:
	 * a session still reads idle for a beat after a prompt goes out
	 * (`watchSessions`). A session the state no longer holds leaves the
	 * levels, an `ended` or a gap having settled its watch already.
	 */
	const foldTurns = (): void => {
		const streaming = new Map(Object.entries(state.sessions).map(([handle, view]) => [handle, view.isStreaming]));
		const before = turnWatch;
		turnWatch = watchSessions(turnWatch, streaming, false);
		for (const [handle, isStreaming] of streaming) {
			const was = levels.get(handle);
			levels.set(handle, isStreaming);
			const watched = before.waiting.has(handle) && !turnWatch.waiting.has(handle);
			if ((was === true && !isStreaming) || watched) turnEnded(handle, state.sessions[handle]!.ref, watched);
		}
		for (const handle of levels.keys()) if (!streaming.has(handle)) levels.delete(handle);
	};

	/**
	 * Forward the snapshot `event`, whose view the reducer now holds under
	 * its handle, to the view bound to the handle, if any. Nothing but a
	 * snapshot binds a view (OW-rebawa), since only a snapshot tells Emacs
	 * the buffer is attached, and an attach is answered by its reply
	 * (`bind`), never here, whatever ref the snapshot names. Until OW-wukako
	 * one was answered by the ref it asked for, and a snapshot under an
	 * older handle for that ref -- another client's attach, or an opening
	 * snapshot -- answered it ahead of the reply naming the handle the server
	 * had since minted, whose own snapshot and events then went nowhere
	 * (OW-savafi).
	 */
	const introduce = (event: Extract<ServerEvent, { type: "snapshot" }>): void => {
		const { handle } = event;
		const bound = holderOf(handle);
		if (bound === undefined) return;
		notifySnapshot(state.sessions[handle]!, bound, handle);
	};

	/** Drop every node held under `handle`. */
	const dropHeld = (handle: string): void => {
		for (const [key, node] of waiting) if (node.handle === handle) waiting.delete(key);
	};

	/** Unbind the view bound to `held`, if any, and tell it `session/detached`, naming `session`, the ref it last had. */
	const release = (held: string, session: SessionRef): void => {
		const bound = holderOf(held);
		if (bound === undefined) return;
		views.delete(bound);
		dropHeld(held);
		notify({ method: "session/detached", params: { session, view: bound, handle: held } });
	};

	/**
	 * The server let go of `handle` (D26): a close, by any client, or on Pi a
	 * fork moving the process onto a conversation of its own, and nothing
	 * comes under it again. The view bound to it is unbound and Emacs is
	 * told, `session` being the ref the view last had: a buffer left counting
	 * itself attached would send a prompt the helper would send by the ended
	 * handle, which the server refuses (D25, D30). The buffer lets go of the
	 * handle, and its own next attach, by the ref it holds, finds the session
	 * wherever it is now, the server answering the current handle and ref.
	 * Re-attaching here instead would respawn the session the other client
	 * closed. An attach still out whose reply names the handle finds no view
	 * under it, and binds nothing (`bind`).
	 * The turn under it is over: a watch on it that has seen streaming
	 * raises, as agentpane-mode raised at an `ended` before D32, and any
	 * watch on it goes (D32 point 6). The browser leaves such a watch
	 * waiting and raises nothing.
	 */
	const end = (handle: string, session: SessionRef): void => {
		if (turnWatch.waiting.get(handle) === true) turnEnded(handle, session, true);
		unwatch(handle);
		release(handle, session);
	};

	/**
	 * Detach the session whose `seq` gapped under `handle` (D25 point 5): its
	 * view goes, so no later event under the handle is applied to it, or gaps
	 * against it again, until a snapshot forms it afresh; and the view of
	 * Emacs's bound to it is unbound and told, as for a handle the server let
	 * go (`end`). Nothing is attached on Emacs's behalf: an attach is what
	 * spawns, and one here would spawn again a session whose
	 * `sessions/close` is out. The buffer comes back by a send or `a`, `g`
	 * previewing it (D26). An attach still out whose reply names the handle
	 * finds no view under it, and ends with the buffer not attached, which
	 * point 5 accepts (`bind`). The watch on the handle goes, raising
	 * nothing, streamed or not: a later snapshot under the handle cannot say
	 * whether the turn it shows ending is the one watched (D25 point 5).
	 */
	const detachGapped = (handle: string): void => {
		const session = state.sessions[handle]?.ref;
		const sessions = { ...state.sessions };
		delete sessions[handle];
		state = { ...state, sessions };
		unwatch(handle);
		if (session !== undefined) release(handle, session);
	};

	const onEvent = (event: ServerEvent): void => {
		const before = state;
		forward(event);
		if (state !== before) foldTurns();
	};

	/** Apply `event` to the reducer's state, and send Emacs what it says for a bound view. */
	const forward = (event: ServerEvent): void => {
		const before = state;
		const result = reduceServerEvent(before, event);
		state = result.state;
		if (result.refreshSessions) notify({ method: "sessions/changed" });
		// A gapped event applied nothing, and there is nothing more to say of it.
		if (result.recover.length > 0) {
			for (const { handle } of result.recover) detachGapped(handle);
			return;
		}
		if (event.type === "sessions-changed") return;
		if (event.type === "ended") {
			end(event.handle, before.sessions[event.handle]?.ref ?? event.session);
			return;
		}

		if (state === before) return;

		if (event.type === "snapshot") {
			introduce(event);
			return;
		}
		const { handle } = event;
		const bound = holderOf(handle);
		if (bound === undefined) return;
		const view = state.sessions[handle]!;
		switch (event.type) {
			case "upsert": {
				const target = locateUpsert(before.sessions[handle]!.messages, event.index, event.message);
				const key = JSON.stringify([handle, target.entry.index]);
				waiting.set(key, { session: view.ref, view: bound, handle, target, isStreaming: view.isStreaming });
				flushTimer ??= setTimeout(flushNodes, NODE_INTERVAL_MS);
				return;
			}
			case "status":
				notify({ method: "session/status", params: statusOf(view, bound, handle) });
				return;
			case "error":
				notify({ method: "session/error", params: { session: view.ref, view: bound, handle, message: event.message, errorId: event.errorId } });
				return;
			case "error-cleared":
				notify({ method: "session/errorCleared", params: { session: view.ref, view: bound, handle } });
				return;
			case "notice":
				notify({ method: "session/notice", params: { session: view.ref, view: bound, handle, notice: event.notice } });
				return;
		}
	};

	/**
	 * Stop telling Emacs about `view`'s session, for its `sessions/detach`:
	 * its buffer was killed, or is a Pi fork's parent. Each attach it has out
	 * is given up, so no snapshot answers it later, and the view's binding
	 * goes, so no reply names it.
	 */
	const detach = (view: View): void => {
		for (const attach of attaching) if (attach.view === view) attach.done = true;
		attachesOut.delete(view);
		const handle = views.get(view);
		// Nothing more is heard here of that handle's turn, as a closed tab hears nothing (D32 point 6).
		unwatch(handle);
		views.delete(view);
		if (handle !== undefined) dropHeld(handle);
	};

	// Opened by the first request for a known method, whose reply then follows the opening
	// snapshots, and every event after them (D31 point 1).
	let connection: ReturnType<typeof api.connect> | null = null;
	const connect = (): void => {
		connection ??= api.connect(socketHandlers);
	};
	const disconnect = (): void => connection?.close();
	const socketHandlers: EventHandlers = {
		onEvent,
		onOpen() {},
		// A close, or a failed first open, ends the helper (D25 point 4):
		// cancelling the input ends the read loop below as its end would, and
		// under `main.ts` the process with it, Emacs's end of stdin still open
		// (bun 1.4.0, measured 2026-09-28). A node the throttle holds goes out
		// first, since no timer will send it after the exit. The api client has
		// settled every request still out before it reports this, and their
		// replies, for those that get one, are written as they land: under Bun
		// the input's end once outran such replies to a teardown that silenced
		// them, and they are written because nothing is silent but the
		// connection lost, whenever it lands (bun 1.4.0, measured 2026-09-30;
		// OW-nuzoto). Under node they win anyway, and the vitest case passes
		// either way: only `resources/probes/emacs_helper_no_server_probe.py`
		// sees it.
		// Each turn-done watch that has seen streaming is raised before the
		// exit, the server having gone and its turns with it (D31 point 6),
		// as the browser's `watchClose` badges. The input's end closes the
		// socket from this end, which reports no disconnect, so it raises
		// nothing (D25 point 4).
		onDisconnect() {
			if (stopped) return;
			flushNodes();
			for (const [handle, sawStreaming] of turnWatch.waiting) {
				const session = state.sessions[handle]?.ref;
				if (sawStreaming && session !== undefined) turnEnded(handle, session, true);
			}
			turnWatch = watchClose(turnWatch, false);
			stopped = true;
			void reader.cancel();
		},
		// The server frames its own JSON, so a frame that fails to parse is a
		// server bug, not a case to defend (D26 point 4). It has no session to
		// report against. Dropped, it costs a seq gap where a later event under
		// its handle detaches that one session, and where none follows, as none
		// follows an `ended`, an attachment Emacs is never told has gone; a lost
		// snapshot forms no view, so the attach it answered binds nothing.
		onMalformed() {},
	};

	const handlers: Handlers = {
		"sessions/list": (params) => api.listSessions(params?.cwd),
		"sessions/preview": async ({ session }) => {
			const preview = await api.preview(session);
			// A preview is a stored session, never live, so nothing in it is running.
			return projectTranscript(previewMessages(preview.turns), false, render);
		},
		// An attach of the new session for `view`, as well as the operation
		// (D30), bound as `sessions/attach` binds its own.
		"sessions/create": async ({ view, ...body }) => {
			const { reply, holder } = await attachingBy(view, () => api.createSession(body), (summary) => summary.handle, (summary) => summary);
			return naming(reply, holder);
		},
		"models/list": ({ backend }) => api.listModels(backend),
		// The reply follows the snapshot the attach broadcast, or the opening
		// snapshot of a session already live, so the reducer holds the view the
		// reply's handle names, and the snapshot that binds the buffer goes
		// out from it ahead of the reply (`bind`). `session.ref` in the reply is
		// authoritative and may differ from the one asked for (D9). A second
		// attach from a view whose first is still out joins it, sending the
		// server nothing and answering as the first does (D32 point 4).
		"sessions/attach": async ({ session, view }) => {
			refuseForking(session);
			const out = attachesOut.get(view);
			if (out) {
				const { summary, holder } = await out;
				if (summary === undefined) throw new ApiClientError("not_attached", "the attach this one joined attached no session");
				return naming(summary, holder);
			}
			const { reply, holder } = await attachingBy(view, () => api.attach(session), (summary) => summary.handle, (summary) => summary);
			return naming(reply, holder);
		},
		// One at a time from a view, a second refused `busy` (D32 point 4).
		// Routed by the view's binding (D30): a bound view's goes only to the
		// live session under its handle; an unbound view's waits on the
		// view's attach still out, if any, and then goes under the handle that
		// attach bound, or is refused with its error, or `not_attached` where
		// it bound nothing or landed on another view's handle, naming that
		// view; with none out it is an attach for the view as well, the server
		// attaching the session if it must, bound as `sessions/attach` binds
		// its own, a refusal naming the session attached included, and
		// refused while a fork and prompt of the session is out. One marked
		// `live` from an unbound view, whose binding an `ended` or a gap took
		// after it was sent, is refused before any wait, since by ref it would
		// resume what was closed. Emacs gets the disposition, and the view
		// holding the session where another does.
		"sessions/prompt": ({ session, view, live, ...body }) =>
			sending(view, async () => {
				let handle = views.get(view);
				if (handle === undefined && live) liveHandle(view);
				const out = handle === undefined ? attachesOut.get(view) : undefined;
				if (out) {
					const { summary, holder, bound } = await out;
					handle = views.get(view);
					if (bound === undefined || handle !== bound) {
						const refusal = new ApiClientError("not_attached", "the attach this prompt waited on did not attach this buffer", undefined, summary && { ref: summary.ref, handle: summary.handle! });
						throw holder === undefined ? refusal : new HeldElsewhere(refusal, holder);
					}
				}
				if (handle === undefined) refuseForking(session);
				// The handle this prompt armed the turn-done watch on, the only
				// one its refusal or handled answer takes down (D32 point 6).
				let armed: string | undefined;
				const armOn = (landed: string): void => {
					if (arm(landed)) armed = landed;
				};
				try {
					let sent: { reply: Awaited<ReturnType<typeof api.prompt>>; holder: View | undefined };
					if (handle !== undefined) {
						armOn(handle);
						sent = { reply: await api.prompt(session, { ...body, handle }), holder: undefined };
					} else {
						sent = await attachingBy(
							view,
							() => api.prompt(session, body),
							(reply) => reply?.session?.handle,
							(reply) => reply?.session,
							armOn,
						);
					}
					const { reply, holder } = sent;
					if (reply?.disposition === "handled") unwatch(armed);
					const answer = reply?.disposition === "handled" ? { disposition: "handled" as const } : null;
					return holder === undefined ? answer : { ...answer, view: holder };
				} catch (error: unknown) {
					if (error instanceof ApiClientError || error instanceof HeldElsewhere) unwatch(armed);
					throw error;
				}
			}),
		// `unwatch`, from agentpane-mode's plain Pi fork, drops the view's
		// turn-done watch first, the user having stopped that turn on purpose
		// (D32 point 6); ark3/agentpane#17 retires it with that fork.
		"sessions/abort": async ({ view, unwatch: drop }) => {
			const handle = liveHandle(view);
			if (drop) unwatch(handle);
			return (await api.abort(handle)) ?? null;
		},
		// A view's compact still out holds its sends and a second compact,
		// `busy`, as the browser's `compacting` holds Send and Compact from the
		// click to the reply (D32 point 4).
		"sessions/compact": async ({ view }) => {
			if (compactsOut.has(view)) throw new ApiClientError("busy", "a compaction requested from this buffer has not answered");
			const handle = liveHandle(view);
			compactsOut.add(view);
			try {
				await api.compact(handle);
			} finally {
				compactsOut.delete(view);
			}
			return null;
		},
		// By ref, as ever. The view's binding goes at the `ended` the close
		// brings, which the server writes ahead of the reply (D31 point 3),
		// and so does the turn-done watch on its handle; whatever still stands
		// on the handle the view held as the close went out goes at the reply.
		"sessions/close": async ({ session, view }) => {
			const handle = views.get(view);
			await api.close(session);
			unwatch(handle);
			return null;
		},
		"sessions/dismissError": async ({ view, errorId }) => {
			await api.dismissError(liveHandle(view), errorId);
			return null;
		},
		// Emacs no longer shows the session, and nothing more: unlike `close`,
		// the session goes on running on the server.
		"sessions/detach": async ({ view }) => {
			detach(view);
			return null;
		},
		"sessions/setModel": async ({ view, model }) => {
			await api.setModel(liveHandle(view), model);
			return null;
		},
		"sessions/setEffort": async ({ view, effort }) => {
			await api.setEffort(liveHandle(view), effort);
			return null;
		},
		"sessions/setName": async ({ view, name }) => {
			await api.setName(liveHandle(view), name);
			return null;
		},
		"sessions/forkPoints": async ({ view }) => api.forkPoints(liveHandle(view)),
		// `unwatch`, from agentpane-mode's plain Pi fork, drops the view's
		// turn-done watch first, as `sessions/abort`'s does (D32 point 6); a Pi
		// fork stops the parent's turn, streamed or not, and its end is not
		// news. ark3/agentpane#17 retires it with that fork.
		"sessions/fork": async ({ session: _session, view, unwatch: drop, ...body }) => {
			const handle = liveHandle(view);
			if (drop) unwatch(handle);
			return api.fork(handle, body);
		},
		// An attach of the fork for `forkView`, the buffer agentpane-mode made
		// for it before sending (D32 point 3), as well as the operation (D30):
		// the fork's snapshot, broadcast before its prompt goes out, is bound
		// as an attach's binds that attach. So does a refusal naming a fork
		// that was attached; one whose own start failed names no handle, and
		// binds nothing.
		// It is `view`'s send still out, refused `busy` beside a prompt from
		// it, and while it is out nothing attaches the session forked, by any
		// ref it is known by, from any view (D32 point 4).
		// The fork's turn-done watch arms at the reply, unless its prompt was
		// handled, from the level the fork's view holds then, as the browser's
		// `send()` arms it; with `stops`, the parent's watch goes as the
		// request goes out, the user stopping that turn by forking it
		// (OW-rihanu, D32 point 6).
		"sessions/forkAndPrompt": ({ session, view, forkView, stops, ...body }) =>
			sending(view, async () => {
				const handle = liveHandle(view);
				if (stops) unwatch(handle);
				const forked = [session, state.sessions[handle]?.ref].filter((ref) => ref !== undefined).map(keyOf);
				forksOut.add(forked);
				try {
					const { reply, holder } = await attachingBy(forkView, () => api.forkAndPrompt(handle, body), (reply) => reply.session.handle);
					if (reply.disposition !== "handled" && reply.session.handle) arm(reply.session.handle);
					return naming(reply, holder);
				} finally {
					forksOut.delete(forked);
				}
			}),
	};

	const respond = async (request: JsonRpcRequest): Promise<void> => {
		const { id, method } = request;
		if (id === undefined || id === null) return; // A notification from Emacs: nothing to answer, and none is defined.
		const handler = (handlers as Record<string, (params: unknown) => Promise<unknown>>)[method ?? ""];
		// Answered here, with nothing to ask the server, so it opens no socket.
		if (!handler) {
			write(encodeFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${JSON.stringify(method)}` } }));
			return;
		}
		if (!stopped) connect();
		try {
			const result = await handler(request.params);
			write(encodeFrame({ jsonrpc: "2.0", id, result }));
		} catch (error: unknown) {
			// Lost with the socket: no reply; see `runHelper`.
			if (error instanceof ConnectionLostError) return;
			const [cause, holder] = error instanceof HeldElsewhere ? [error.refusal, error.view] : [error, undefined];
			const named =
				cause instanceof ApiClientError && cause.code === "unauthorized"
					? new ApiClientError(cause.code, refusal, cause.fork, cause.attached)
					: cause;
			write(encodeFrame({ jsonrpc: "2.0", id, error: toRpcError(named, holder) }));
		}
	};

	const decoder = new FrameDecoder();
	for (;;) {
		const { done, value: chunk } = await reader.read();
		if (done) break;
		for (const message of decoder.push(chunk)) void respond(message as JsonRpcRequest);
	}

	stopped = true;
	clearTimeout(flushTimer);
	waiting.clear();
	disconnect();
}

/** `holder`, where given, is the view holding the session the refusal's `attached` or `fork` names (D32 point 2). */
function toRpcError(error: unknown, holder?: View): { code: number; message: string; data?: unknown } {
	if (error instanceof ApiClientError) {
		const viewed = holder === undefined ? {} : { view: holder };
		return {
			code: REFUSED,
			message: error.message,
			data: {
				error: error.code,
				detail: error.detail,
				...(error.fork ? { fork: { ...error.fork, ...viewed } } : {}),
				...(error.attached ? { attached: { ...error.attached, ...viewed } } : {}),
			},
		};
	}
	return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}
