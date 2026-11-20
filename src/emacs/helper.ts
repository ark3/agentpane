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
 * view goes, and Emacs is told `session/detached` under its handle where it
 * attached it, and nothing is attached on its behalf (`detachGapped` below).
 *
 * One socket, filtered. It opens as the first request is read, and stays
 * open until the helper exits; a request read before it has opened goes out
 * behind its `hello`. Not at the helper's start: with no server listening,
 * the failed open would end the helper before it read the request Emacs had
 * already written, which would then get no reply, where it is owed one
 * saying the server could not be reached (OW-pezelo). Replies and events arrive on it in the order the server wrote
 * them, and a command's reply follows everything it caused (D31 point 3):
 * an attach's reply follows the snapshot it broadcast, and a listing's reply
 * is ordered against the `sessions-changed` around it (OW-nufafi). The
 * server sends an opening snapshot for every live session and broadcasts
 * every event to every client, so views Emacs never attached form in the
 * reducer too; notifications go out only for sessions Emacs attached through this
 * helper and has not detached or closed since. That set is kept here by
 * handle, like the reducer's views (OW-kimaya), so a rename moves nothing in
 * it. An attachment is recorded when the snapshot that introduces it goes
 * out to Emacs, and at nothing else (OW-rebawa): that snapshot is what
 * attaches the buffer that asked, and the attach's reply only ends its
 * request (`agentpane--attach` in emacs/agentpane.el), so the helper feeds
 * exactly the buffers it has told they are attached. The snapshot that
 * answers an attach goes out as its reply is handled, from the view the
 * reducer holds under the handle the reply names, which the attach's own
 * snapshot formed before the reply arrived; so it goes out before the
 * reply, and the buffer reads at the reply whether it is attached
 * (`bind` below). An attachment never moves to another handle: one whose
 * handle the server let go of is dropped at the `ended` the server sends
 * under it, and Emacs told (`end` below, D26); a listing drops nothing.
 * `sessions/changed` is unfiltered.
 *
 * Every per-session notification carries the session's `handle` (D24,
 * OW-suyinu), taken from the raw event being answered, or from the attach
 * reply's summary for what `sessions/attach` says itself. Requests accept one
 * beside `session`, and send it nowhere, `sessions/detach` and
 * `sessions/close` included: those stop an attachment by the `tokens` they
 * carry, and the attachment under a handle goes once every token answered
 * under it is released (`forget` below, OW-nowihu). No notification says a
 * rename: agentpane-mode keys its buffers by the handle (OW-danifa) and
 * takes the ref from any notification under it, as the reducer does, so the
 * snapshot under the handle that follows a rename on the server is all it
 * needs (OW-mofuho). What that is not enough for is the snapshot that
 * answers an attach, which must reach the buffer that asked: that buffer
 * holds no handle yet, and may hold another ref than the snapshot names,
 * or the ref of a session another buffer holds under that handle, and the
 * reply binds nothing. So agentpane-mode mints a token for each attach it
 * sends, and each snapshot that answers an attach carries that attach's
 * `token`, one such snapshot for each attach it answers, and agentpane-mode
 * binds it to the buffer that sent it, which takes the handle from it and
 * absorbs a buffer already holding the handle (`introduce` below,
 * `agentpane--notified-buffer` and `agentpane--attach-by` in
 * emacs/agentpane.el). The helper keeps each attach it waits on by that
 * token, and a detach or close gives up only the attaches whose tokens it
 * carries: until OW-wukako both went by the ref asked for, which another
 * buffer's attach, or a snapshot under a handle the server had since let
 * go of, could share (OW-jofodu, OW-savafi). The helper does not
 * reconnect: when the socket closes, or fails to open, the helper exits
 * (D25 point 4, D31 point 6). Agentpane is local-only, so a close means the
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
 * have sent. A detach or close drops what is held for its session, and the
 * end of the input drops everything held, so no timer keeps the process up
 * past it (OW-kofuda). A held node whose rendering throws is skipped and the
 * rest still go out (OW-vejeka): the send runs from the timer, where a throw
 * ends the process (measured on Bun 1.4.0), and from every other write,
 * where it would answer a request that succeeded with an error, or throw
 * out of the socket's handler from `onEvent`; and either way the nodes held
 * behind it would be lost.
 */

import { ApiClientError, ConnectionLostError, createAgentpaneApi, type ApiOptions, type EventHandlers } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { initialClientState, reduceServerEvent, type ClientState, type SessionView } from "$client/session-state.ts";
import type { ServerEvent, SessionRef } from "$shared/protocol.ts";
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

/**
 * A request that attaches a session for the buffer that sent `token`
 * (OW-rebawa, OW-wukako), not yet replied to; `done` once its snapshot has
 * gone out, or a detach or close carrying its token gave it up (`forget`).
 */
interface Attaching {
	token: number;
	done: boolean;
}

/** An upsert not yet sent: what `session/node` will say, short of the rendering. */
interface HeldNode {
	session: SessionRef;
	handle: string;
	target: UpsertTarget;
	isStreaming: boolean;
}

/**
 * Runs until `input` ends, or the socket closes or fails to open (D25 point
 * 4); then closes the socket and resolves.
 *
 * A request still out when the socket closes gets no reply (OW-hiliti): the
 * api client settles it as the connection lost, which says nothing of
 * whether it reached the backend (D31 point 6), so agentpane-mode answers it
 * as the helper's death, and the echo area says the helper exited. That
 * holds whichever end closed it, the server going away or this helper
 * closing it as `input` ended. agentpane-mode takes only a refusal carrying
 * the server's `error` code as saying a request reached no backend, and
 * reads any other error reply, this helper's own -32603 among them, as an
 * outcome unknown, leaving a prompt's turn-done watch for its teardown to
 * settle (`agentpane--request` in emacs/agentpane.el, OW-zedawo).
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
	/** Handle of each session Emacs has attached -> the ref it last told Emacs, which is the one Emacs names it by. */
	const attached = new Map<string, SessionRef>();
	/** Every request that attaches, not yet replied to; see `Attaching`. */
	const attaching = new Set<Attaching>();
	/** Handle of each session Emacs has attached -> the token of every attach answered under it that Emacs has not released; see `forget`. */
	const claims = new Map<string, Set<number>>();
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
		for (const { session, handle, target, isStreaming } of nodes) {
			let node: TranscriptNode;
			try {
				node = projectTarget(target, isStreaming, render);
			} catch {
				continue;
			}
			const notification: HelperNotification = { method: "session/node", params: { session, handle, node } };
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

	const statusOf = (view: SessionView, handle: string | undefined) => ({
		session: view.ref,
		handle,
		isStreaming: view.isStreaming,
		compaction: view.compaction ?? null,
		model: view.model,
		effort: view.effort,
		unrestoredModel: view.unrestoredModel ?? null,
	});

	/** Send `view` as a snapshot under `handle`, answering the attach that sent `token` if given. */
	const notifySnapshot = (view: SessionView, handle: string, token?: number): void => {
		notify({
			method: "session/snapshot",
			params: {
				...statusOf(view, handle),
				...(token === undefined ? {} : { token }),
				nodes: projectTranscript(view.messages, view.isStreaming, render),
				error: view.error,
				errorId: view.errorId,
				notices: view.notices,
			},
		});
	};

	/**
	 * Answer `attach`, whose reply named `handle`, with the snapshot that
	 * attaches its buffer, from the view the reducer holds under the handle;
	 * called as the reply is handled, and before it goes out. The reply
	 * follows the snapshot its command broadcast, so the view is there,
	 * unless something handled since took it: an `ended` or a gap under the
	 * handle, after which nothing is recorded and the buffer is not attached,
	 * as it should not be (D25 point 5, D26). Nothing either for an attach a
	 * detach or close gave up while it was out (`forget`).
	 */
	const bind = (attach: Attaching, handle: string): void => {
		if (attach.done) return;
		attach.done = true;
		const view = state.sessions[handle];
		if (!view) return;
		attached.set(handle, view.ref);
		claims.set(handle, (claims.get(handle) ?? new Set()).add(attach.token));
		notifySnapshot(view, handle, attach.token);
	};

	/**
	 * Run `request`, an attach for whoever sent `token`, binding the handle
	 * `handleOf` reads from its reply, or from its refusal where one names a
	 * session it attached (D30).
	 */
	const attachingBy = async <T>(token: number, request: () => Promise<T>, handleOf: (reply: T) => string | null | undefined): Promise<T> => {
		const attach: Attaching = { token, done: false };
		attaching.add(attach);
		try {
			let reply: T;
			try {
				reply = await request();
			} catch (error: unknown) {
				const handle = error instanceof ApiClientError ? (error.attached?.handle ?? error.fork?.handle) : undefined;
				if (handle) bind(attach, handle);
				throw error;
			}
			const handle = handleOf(reply);
			if (handle) bind(attach, handle);
			return reply;
		} finally {
			attaching.delete(attach);
		}
	};

	/**
	 * Forward the snapshot `event`, whose view the reducer now holds under
	 * its handle, to an attachment already under the handle. Nothing but a
	 * snapshot introduces an attachment (OW-rebawa), since only a snapshot
	 * tells Emacs the buffer is attached, and any other event under a handle
	 * Emacs has not been sent one for would reach a buffer that holds nothing
	 * for it; and an attach is answered by its reply (`bind`), never here,
	 * whatever ref the snapshot names. Until OW-wukako one was answered by the
	 * ref it asked for, and a snapshot under an older handle for that ref --
	 * another client's attach, or an opening snapshot -- answered it ahead of
	 * the reply naming the handle the server had since minted, whose own
	 * snapshot and events then went nowhere (OW-savafi).
	 */
	const introduce = (event: Extract<ServerEvent, { type: "snapshot" }>): void => {
		const { handle } = event;
		if (!attached.has(handle)) return;
		attached.set(handle, event.session);
		notifySnapshot(state.sessions[handle]!, handle);
	};

	/** Stop telling Emacs anything under `held`, and forget every claim on it, so no token released later drops anything. */
	const drop = (held: string): void => {
		attached.delete(held);
		claims.delete(held);
		for (const [key, node] of waiting) if (node.handle === held) waiting.delete(key);
	};

	/**
	 * The server let go of `handle` (D26): a close, by any client, or on Pi a
	 * fork moving the process onto a conversation of its own, and nothing
	 * comes under it again. The attachment under it goes and Emacs is told:
	 * a buffer left counting itself attached would send a prompt naming the
	 * ended handle, which the server refuses (D25, D30). The buffer lets
	 * go of the handle, and its own next attach, by the ref it holds, finds
	 * the session wherever it is now, the server answering the current handle
	 * and ref (`agentpane--notified-buffer` in emacs/agentpane.el).
	 * Re-attaching here instead would respawn the session the other client
	 * closed. An attach still out whose reply names the handle finds no view
	 * under it, and records nothing (`bind`).
	 */
	const end = (handle: string): void => {
		const session = attached.get(handle);
		if (session === undefined) return;
		drop(handle);
		notify({ method: "session/detached", params: { session, handle, cause: "ended" } });
	};

	/**
	 * Detach the session whose `seq` gapped under `handle` (D25 point 5): its
	 * view goes, so no later event under the handle is applied to it, or gaps
	 * against it again, until a snapshot forms it afresh; and where Emacs
	 * attached it, the attachment goes and Emacs is told, as for a handle the
	 * server let go (`end`). Nothing is attached on Emacs's behalf: an
	 * attach is what spawns, and one here would spawn again a session whose
	 * `sessions/close` is out. The buffer comes back by a send or `a`, `g`
	 * previewing it (D26). An attach still out whose reply names the handle
	 * finds no view under it, and ends with the buffer not attached, which
	 * point 5 accepts (`bind`).
	 */
	const detachGapped = (handle: string): void => {
		const sessions = { ...state.sessions };
		delete sessions[handle];
		state = { ...state, sessions };
		const session = attached.get(handle);
		if (session === undefined) return;
		drop(handle);
		notify({ method: "session/detached", params: { session, handle, cause: "gapped" } });
	};

	const onEvent = (event: ServerEvent): void => {
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
			end(event.handle);
			return;
		}

		if (state === before) return;

		if (event.type === "snapshot") {
			introduce(event);
			return;
		}
		const { handle } = event;
		if (!attached.has(handle)) return;
		attached.set(handle, event.session);
		const view = state.sessions[handle]!;
		switch (event.type) {
			case "upsert": {
				const target = locateUpsert(before.sessions[handle]!.messages, event.index, event.message);
				const key = JSON.stringify([handle, target.entry.index]);
				waiting.set(key, { session: view.ref, handle, target, isStreaming: view.isStreaming });
				flushTimer ??= setTimeout(flushNodes, NODE_INTERVAL_MS);
				return;
			}
			case "status":
				notify({ method: "session/status", params: statusOf(view, handle) });
				return;
			case "error":
				notify({ method: "session/error", params: { session: view.ref, handle, message: event.message, errorId: event.errorId } });
				return;
			case "error-cleared":
				notify({ method: "session/errorCleared", params: { session: view.ref, handle } });
				return;
			case "notice":
				notify({ method: "session/notice", params: { session: view.ref, handle, notice: event.notice } });
				return;
		}
	};

	/**
	 * Stop telling Emacs about a session, for a `sessions/detach` or
	 * `sessions/close`, by the `tokens` it carries: agentpane-mode sends the
	 * token of every attach its buffer sent, and of every one a buffer it
	 * absorbed sent, save those a close of its already released
	 * (`agentpane--detach` and `agentpane--absorb` in emacs/agentpane.el); a
	 * token released twice releases nothing the second time. Each attach
	 * they name that no snapshot has answered is abandoned, its reply
	 * released if held, so no snapshot answers it later, and no other attach
	 * is: until OW-wukako every attach of the ref was, another buffer's on
	 * the same ref included, so a buffer killed while holding the handle, or
	 * a close carrying it, left the attach in flight beside it not attached
	 * (OW-jofodu). Each token answered under a handle releases its claim
	 * there (`claims`), and the attachment goes with its handle's last claim,
	 * whichever buffer released it; `handle` stops nothing.
	 *
	 * At most one buffer holds a handle -- the one whose attach a snapshot
	 * answers absorbs any other, taking its tokens -- so a claim is one of:
	 * a buffer that holds the handle, or will once it handles the snapshot
	 * on its way; one killed before handling it, which releases the claim
	 * by its own detach; an attach its buffer gave up waiting for, which
	 * that buffer releases with the rest; an attach an absorbed buffer had
	 * in flight, whose snapshot matches no buffer's latest attach and goes
	 * only to the handle's holder, if any, the absorbing buffer releasing
	 * it; or a buffer since moved off the handle -- by an untagged snapshot
	 * under another handle for its ref, or by its own later attach answered
	 * under another handle -- whose claim stays until it detaches. The last
	 * two need two live handles for one ref.
	 *
	 * Until OW-nowihu the handle stopped the attachment under it, and
	 * without one the token stopped the attachment its own answer had
	 * created, and either way a buffer killed after another's answer under
	 * the handle went out -- holding the handle, or before handling the
	 * answer that created the attachment -- silenced the other, which then
	 * bound the handle; and a buffer killed with an attach it gave up
	 * answered and a later one waiting left the first's attachment standing
	 * with no buffer, since its detach named only the later. Until OW-linowe
	 * the attachment went by the ref Emacs was last told, unless the token
	 * gave up an attach. A claim goes with the attachment (`drop`), so the
	 * tokens of a buffer the helper let go of -- a gap or an `ended` --
	 * release nothing.
	 *
	 * What stays, accepted (OW-nowihu):
	 *
	 * - A handle holding claims and no buffer. The buffer told of it was
	 *   killed before handling its snapshot; or the attach answered was one
	 *   its buffer gave up, whose tagged snapshot binds only the handle's
	 *   holder (`agentpane--notified-buffer`); or every claimant moved off
	 *   it. Until the last claim is released the helper goes on sending
	 *   under the handle, and agentpane-mode routes it by the ref: an
	 *   untagged snapshot binds a buffer holding the ref under another
	 *   handle or under none -- the buffer that gave the attach up, or a
	 *   preview that never attached -- and every other notification reaches
	 *   a buffer holding the ref and no handle, so a preview shows it,
	 *   streaming and all. The untagged snapshot can come from the server's
	 *   own, or from the snapshot for the giving-up buffer's later attach
	 *   reaching the helper before that attach's reply, which `introduce`
	 *   sends untagged under the handle already attached. A buffer so bound
	 *   holds no claim, unless it is the one that gave the attach up, and
	 *   hears nothing once the claims are released; an attach given up and
	 *   answered keeps the attachment until its buffer is killed or closes
	 *   its session.
	 * - A Pi fork's parent with a refetch in flight: `agentpane-fork` reads
	 *   `agentpane--attached-p` before `agentpane--attaching`, so `g` then
	 *   `f` forks with the refetch's attach out. Should it reach the server
	 *   after the fork let the parent's container go, it respawns the parent
	 *   under a new handle; should its tagged snapshot be written after the
	 *   fork's reply and before this reads the parent's detach, it binds the
	 *   parent by its token, and the parent counts itself attached, while
	 *   the detach releases that token and drops the attachment.
	 */
	const forget = (tokens: readonly number[] = []): void => {
		for (const token of tokens) {
			const pending = [...attaching].find((attach) => !attach.done && attach.token === token);
			if (pending) pending.done = true;
			for (const [handle, held] of claims) if (held.delete(token) && held.size === 0) drop(handle);
		}
	};

	// Opened by the first request, whose reply then follows the opening
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
		onDisconnect() {
			if (stopped) return;
			flushNodes();
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
		// An attach of the new session for whoever sent `token`, as well as the
		// operation (D30), bound as `sessions/attach` binds its own.
		"sessions/create": ({ token, ...body }) => attachingBy(token, () => api.createSession(body), (summary) => summary.handle),
		"models/list": ({ backend }) => api.listModels(backend),
		// The reply follows the snapshot the attach broadcast, or the opening
		// snapshot of a session already live, so the reducer holds the view the
		// reply's handle names, and the snapshot that attaches the buffer goes
		// out from it ahead of the reply (`bind`). `session.ref` in the reply is
		// authoritative and may differ from the one asked for (D9).
		"sessions/attach": ({ session, token }) => attachingBy(token, () => api.attach(session), (summary) => summary.handle),
		// One naming its handle goes only to the live session under it (D30). One
		// naming none is an attach for the buffer that sent `token` as well:
		// the server attaches the session if it must, and the snapshot that
		// answers it is bound as `sessions/attach` binds its own; so is a
		// refusal naming the session attached. Emacs gets the disposition
		// alone, null for one that started a turn.
		"sessions/prompt": async ({ session, handle, token, ...body }) => {
			const reply =
				handle !== undefined
					? await api.prompt(session, { ...body, handle })
					: await attachingBy(token, () => api.prompt(session, body), (reply) => reply?.session?.handle);
			return reply?.disposition === "handled" ? { disposition: "handled" } : null;
		},
		"sessions/abort": async ({ handle }) => (await api.abort(handle)) ?? null,
		"sessions/compact": async ({ handle }) => {
			await api.compact(handle);
			return null;
		},
		"sessions/close": async ({ session, tokens }) => {
			await api.close(session);
			forget(tokens);
			return null;
		},
		"sessions/dismissError": async ({ handle, errorId }) => {
			await api.dismissError(handle, errorId);
			return null;
		},
		// Emacs no longer shows the session, and nothing more: unlike `close`,
		// the session goes on running on the server.
		"sessions/detach": async ({ tokens }) => {
			forget(tokens);
			return null;
		},
		"sessions/setModel": async ({ handle, model }) => {
			await api.setModel(handle, model);
			return null;
		},
		"sessions/setEffort": async ({ handle, effort }) => {
			await api.setEffort(handle, effort);
			return null;
		},
		"sessions/setName": async ({ handle, name }) => {
			await api.setName(handle, name);
			return null;
		},
		"sessions/forkPoints": ({ handle }) => api.forkPoints(handle),
		"sessions/fork": ({ session: _session, handle, ...body }) => api.fork(handle, body),
		// An attach of the fork for the buffer that sent `token`, as well as the
		// operation (D30): the fork's snapshot, broadcast before its prompt goes
		// out, is bound as an attach's binds that attach. So does a refusal
		// naming a fork that was attached; one whose own start failed names no
		// handle, and binds nothing.
		"sessions/forkAndPrompt": ({ session: _session, handle, token, ...body }) =>
			attachingBy(token, () => api.forkAndPrompt(handle, body), (reply) => reply.session.handle),
	};

	const respond = async (request: JsonRpcRequest): Promise<void> => {
		const { id, method } = request;
		if (id === undefined || id === null) return; // A notification from Emacs: nothing to answer, and none is defined.
		if (!stopped) connect();
		const handler = (handlers as Record<string, (params: unknown) => Promise<unknown>>)[method ?? ""];
		if (!handler) {
			write(encodeFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${JSON.stringify(method)}` } }));
			return;
		}
		try {
			const result = await handler(request.params);
			write(encodeFrame({ jsonrpc: "2.0", id, result }));
		} catch (error: unknown) {
			// Lost with the socket: no reply; see `runHelper`.
			if (error instanceof ConnectionLostError) return;
			const named =
				error instanceof ApiClientError && error.code === "unauthorized"
					? new ApiClientError(error.code, refusal, error.fork, error.attached)
					: error;
			write(encodeFrame({ jsonrpc: "2.0", id, error: toRpcError(named) }));
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

function toRpcError(error: unknown): { code: number; message: string; data?: unknown } {
	if (error instanceof ApiClientError) {
		return {
			code: REFUSED,
			message: error.message,
			data: {
				error: error.code,
				detail: error.detail,
				...(error.fork ? { fork: error.fork } : {}),
				...(error.attached ? { attached: error.attached } : {}),
			},
		};
	}
	return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}
