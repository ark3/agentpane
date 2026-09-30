/**
 * The Emacs helper's loop (OW-refibu): JSON-RPC requests in over stdio, each
 * a thin call through the HTTP api client; the server's event stream fed
 * through the browser's own reducer, and what the buffer needs pushed back
 * out as notifications. The method names and payloads are `protocol.ts`.
 *
 * Testable in node: `main.ts` is only the Bun binding, and everything with
 * behaviour takes its input and output as injectable streams beside `fetch`,
 * `openEvents` and the markdown renderer. `bun run test` runs vitest under
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
 * One stream, filtered. It opens lazily at the first `sessions/list` or
 * `sessions/attach`, and it stays open until the helper exits. Each of
 * those requests waits for the open before its own REST call, a second
 * sent while the first open is pending too (`openStream` below, D26). At
 * the listing so the picker hears `sessions/changed` before anything is
 * attached, and a listing change after the stream is up is not lost between
 * the list and the open (OW-nufafi); at the attach, since a buffer may
 * attach with no listing before it, and the snapshot the attach broadcasts
 * and the REST response are unordered (D2). The server
 * sends an opening snapshot for every live session and broadcasts every
 * event to every client, so views Emacs never attached form in the reducer
 * too; notifications go out only for sessions Emacs attached through this
 * helper and has not detached or closed since. That set is kept here by
 * handle, like the reducer's views (OW-kimaya), so a rename moves nothing in
 * it. An attachment is recorded when the snapshot that introduces it goes
 * out to Emacs, and at nothing else (OW-rebawa): that snapshot is what
 * attaches the buffer that asked, and the attach's reply only ends its
 * request (`agentpane--attach` in emacs/agentpane.el), so the helper feeds
 * exactly the buffers it has told they are attached. And the reply goes
 * out only after the snapshot that answers its attach, or once none ever
 * will, so the buffer reads at the reply whether it is attached
 * (`Attaching` below). An attachment never moves to another handle: one whose
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
 * go of, could share (OW-jofodu, OW-savafi). The hand-rolled
 * reader in `sse.ts` does not retry, and neither does the helper: when the
 * stream drops, or its first open fails, the helper exits (D25 point 4).
 * Agentpane is local-only, so a drop means the server went away, and there
 * is nothing to reconnect to. agentpane-mode takes the exit to mean every
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
 * where it would answer a request that succeeded with an error, or drop the
 * event stream from `onEvent`; and either way the nodes held behind it
 * would be lost.
 */

import { ApiClientError, createAgentpaneApi, type ApiOptions } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { initialClientState, reduceServerEvent, type ClientState, type SessionView } from "$client/session-state.ts";
import type { ServerEvent, SessionRef } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { locateUpsert, projectTarget, projectTranscript, type Render, type UpsertTarget } from "./nodes.ts";
import type { HelperNotification, HelperRequests, TranscriptNode } from "./protocol.ts";

export interface HelperOptions {
	input: ReadableStream<Uint8Array>;
	write: (frame: Uint8Array) => void;
	fetch: typeof fetch;
	openEvents: NonNullable<ApiOptions["openEvents"]>;
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
 * A `sessions/attach` not yet replied to (OW-rebawa): the token
 * agentpane-mode minted for it (OW-wukako); the handle its reply named,
 * once the reply waits on a snapshot under it; every handle a snapshot came
 * under since it went out; whether a snapshot answered it or it was given
 * up on; and, while its reply waits, the function that sends it on.
 */
interface Attaching {
	token: number;
	handle?: string;
	seen: Set<string>;
	done: boolean;
	release?: () => void;
}

/** An upsert not yet sent: what `session/node` will say, short of the rendering. */
interface HeldNode {
	session: SessionRef;
	handle: string;
	target: UpsertTarget;
	isStreaming: boolean;
}

/**
 * Runs until `input` ends, or the event stream drops or fails its first open
 * (D25 point 4); then closes the stream, aborts every request still
 * waiting on the server, and resolves. Each request is answered detached from
 * the read loop, so without the abort a server that never answers holds its
 * socket, and Bun's event loop and the process with it, open past the end of
 * `input` (OW-kofuda). No api method passes a signal of its own.
 *
 * A request the abort ends gets no reply (OW-hiliti). The abort is the
 * helper's own, and says nothing of whether the request reached the
 * backend, so agentpane-mode answers such a request as the helper's death,
 * and the echo area says the helper exited rather than that the operation
 * was aborted. That is all the silence still decides: agentpane-mode takes
 * only a refusal carrying the server's HTTP status as saying a request
 * reached no backend, and reads any other error reply, this helper's own
 * -32603 among them, as an outcome unknown, leaving a prompt's turn-done
 * watch for its teardown to settle (`agentpane--request` in
 * emacs/agentpane.el, OW-zedawo). The -32603 cannot all be silenced here:
 * with the server killed and a prompt in flight, the socket's error reached
 * `respond` before the drop had aborted anything in all 32 runs of
 * `resources/probes/emacs_helper_server_death_probe.el` (bun 1.4.0,
 * measured 2026-09-29; docs/MANUAL_TESTING.md, OW-hiliti). The test is
 * what failed the request, not when (OW-nuzoto): only a failure the abort
 * caused, the signal's own reason or an `AbortError` once it has fired,
 * goes unanswered, so one that failed on its own in the same instant gets
 * its own error, which agentpane-mode reads as an outcome unknown too.
 * Until OW-nuzoto the test was whether the abort had run, and such a
 * request went unanswered. A call to the server attempted once `stopped`
 * is set is refused, and its request answered that the helper is exiting:
 * sent, the call would be aborted and its reply silenced, though it might
 * have reached a backend. That reaches a request read from a chunk the
 * input delivered before it was cancelled, and a `sessions/list` or
 * `sessions/attach` whose wait on the stream's open resumes after
 * `onDisconnect`; a request that calls nothing, as `sessions/detach`,
 * still runs and is answered as ever. Writing
 * nothing keeps nothing open: with a prompt in flight, the helper exited
 * 0.029s to 0.030s after its stdin closed, as fast as OW-kofuda measured
 * (bun 1.4.0, measured 2026-09-29).
 */
export async function runHelper(options: HelperOptions): Promise<void> {
	const { render } = options;
	const inFlight = new AbortController();
	const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		stopped
			? Promise.reject(new Error("the agentpane helper is exiting"))
			: options.fetch(input, { ...init, signal: inFlight.signal })) as typeof globalThis.fetch;
	/** Whether `error` is the teardown's own abort of a call, the one failure `respond` answers nothing for. */
	const abortedHere = (error: unknown): boolean =>
		inFlight.signal.aborted && (error === inFlight.signal.reason || (error instanceof Error && error.name === "AbortError"));
	const api = createAgentpaneApi({ fetch, openEvents: options.openEvents });

	let state: ClientState = initialClientState();
	/** Handle of each session Emacs has attached -> the ref it last told Emacs, which is the one Emacs names it by. */
	const attached = new Map<string, SessionRef>();
	/** Every `sessions/attach` not yet replied to; see `Attaching`. */
	const attaching = new Set<Attaching>();
	/** Handle of each session Emacs has attached -> the token of every attach answered under it that Emacs has not released; see `forget`. */
	const claims = new Map<string, Set<number>>();
	let connection: ReturnType<typeof api.connect> | null = null;
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

	/** Answer `attach` with `view`, the snapshot under `handle` that attaches it, and release its reply. */
	const answer = (attach: Attaching, view: SessionView, handle: string): void => {
		attach.done = true;
		attached.set(handle, view.ref);
		claims.set(handle, (claims.get(handle) ?? new Set()).add(attach.token));
		notifySnapshot(view, handle, attach.token);
		attach.release?.();
	};

	/** Give up on `attach`'s snapshot, and release its reply: nothing is recorded for it. */
	const abandon = (attach: Attaching): void => {
		attach.done = true;
		attach.release?.();
	};

	/**
	 * Forward the snapshot `event`, whose view the reducer now holds under
	 * its handle, to every attach it answers and to an attachment already
	 * under the handle: nothing but a snapshot introduces an attachment
	 * (OW-rebawa), since only a snapshot tells Emacs the buffer is attached,
	 * and any other event under a handle Emacs has not been sent one for
	 * would reach a buffer that holds nothing for it. It answers each attach
	 * waiting on its handle, whose reply named it, with a snapshot of its own
	 * carrying that attach's `token`, so one attaching an alias and one the
	 * session's own ref, both waiting on it, each reach their own buffer,
	 * which agentpane-mode then merges. An attach whose reply has not come is
	 * answered by nothing here, whatever ref the snapshot names: until
	 * OW-wukako one was answered by the ref it asked for, and a snapshot
	 * under an older handle for that ref -- another client's attach, or an
	 * opening snapshot -- answered it ahead of the reply naming the handle
	 * the server had since minted, whose own snapshot and events then went
	 * nowhere (OW-savafi). The reply answers it from the view under the
	 * handle it names, so a snapshot that beats the reply costs nothing.
	 * Every attach waiting notes the handle, so a reply that finds no view
	 * under it can tell a snapshot a gap took (`detachGapped`) from one
	 * still on its way.
	 */
	const introduce = (event: Extract<ServerEvent, { type: "snapshot" }>): void => {
		const { handle } = event;
		const view = state.sessions[handle]!;
		const answers = [...attaching].filter((attach) => !attach.done && attach.handle === handle);
		for (const attach of attaching) attach.seen.add(handle);
		if (answers.length === 0) {
			if (!attached.has(handle)) return;
			attached.set(handle, event.session);
			notifySnapshot(view, handle);
			return;
		}
		for (const attach of answers) answer(attach, view, handle);
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
	 * a buffer left counting itself attached would send a prompt with no
	 * attach before it, which the prompt route refuses (D25). The buffer lets
	 * go of the handle, and its own next attach, by the ref it holds, finds
	 * the session wherever it is now, the route answering the current handle
	 * and ref (`agentpane--notified-buffer` in emacs/agentpane.el).
	 * Re-attaching here instead would respawn the session the other client
	 * closed. An attach whose reply waits on a snapshot under the handle is
	 * abandoned, since that snapshot will not come, and its reply goes out
	 * with nothing recorded. Such an attach has no view in the reducer yet,
	 * which is why `onEvent` comes here before its return on a state the
	 * reducer left unchanged.
	 */
	const end = (handle: string): void => {
		const session = attached.get(handle);
		if (session !== undefined) {
			drop(handle);
			notify({ method: "session/detached", params: { session, handle, cause: "ended" } });
		}
		for (const attach of attaching) if (!attach.done && attach.handle === handle) abandon(attach);
	};

	/**
	 * Detach the session whose `seq` gapped under `handle` (D25 point 5): its
	 * view goes, so no later event under the handle is applied to it, or gaps
	 * against it again, until a snapshot forms it afresh; and where Emacs
	 * attached it, the attachment goes and Emacs is told, as for a handle the
	 * server let go (`end`). Nothing is attached on Emacs's behalf: an
	 * attach is what spawns, and one here would spawn again a session whose
	 * `sessions/close` is out. The buffer comes back by a send or `a`, `g`
	 * previewing it (D26). An attach whose
	 * snapshot is still on its way when the gap lands needs nothing here:
	 * that snapshot forms the view again and goes out as its first
	 * notification, unless the reply lands before it and finds that a
	 * snapshot under the handle came since the attach went out -- one from
	 * elsewhere, another client's attach or an opening snapshot, ahead of
	 * the server handling this attach -- which the reply takes for this
	 * attach's own, taken by the gap: it goes out with nothing recorded, and
	 * the snapshot that follows answers nothing. That takes a lost or
	 * malformed frame for the gap, and leaves the buffer not attached, which
	 * point 5 accepts. One whose snapshot arrived before the gap, and before
	 * its reply, needs nothing either: no snapshot answers an attach ahead of
	 * its reply (`introduce`), so that one recorded nothing, and the reply,
	 * finding no view under a handle a snapshot came under since the attach
	 * went out, sends nothing and records nothing either, rather than wait
	 * for a snapshot that will not come (OW-tifiva). Either way the attach
	 * ends with the buffer not attached. Since OW-wukako both reach an attach
	 * of the session's own ref as they always reached one of an alias, the
	 * misjudgment with them: until then a snapshot for the ref an attach
	 * asked for answered it on arrival, reply or no, and only one naming
	 * another ref was left for the reply to judge.
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
			if (pending) abandon(pending);
			for (const [handle, held] of claims) if (held.delete(token) && held.size === 0) drop(handle);
		}
	};

	const closeStream = (): void => {
		connection?.close();
		connection = null;
	};

	/**
	 * Open the stream, once, and settle when it has opened (D26 point 4).
	 * The events GET and a request's own are separate connections, so a
	 * request sent before the server registered this client could have what
	 * it waits on -- an attach's snapshot, a close's `ended` -- broadcast to
	 * every client but this one. The open reports once the response headers
	 * arrive (`sse.ts`), and the server registers the client in the stream's
	 * `start()` (`openEventStream` in src/server/http/app.ts), which runs
	 * inside `new ReadableStream(...)`, before the `Response` exists: so an
	 * open means registered. A first open that fails rejects, saying the
	 * server could not be reached, and the helper ends (`onDisconnect`).
	 */
	let opened: Promise<void> | undefined;
	const openStream = (): Promise<void> =>
		(opened ??= new Promise<void>((resolve, reject) => {
			let open = false;
			connection = api.connect({
				onEvent,
				onOpen() {
					open = true;
					resolve();
				},
				// A drop, or a failed first open, ends the helper (D25 point 4):
				// cancelling the input ends the read loop below as its end would,
				// and under `main.ts` the process with it, Emacs's end of stdin
				// still open (bun 1.4.0, measured 2026-09-28). A node the throttle
				// holds goes out first, since no timer will send it after the exit.
				// A failed first open is where a server that is not running shows,
				// so each request waiting on it answers that (OW-pezelo), with no
				// `data.status`, which would say a server refused it. Those replies
				// are chains of microtasks from the rejection, and under Bun the
				// input's end outruns them to the teardown's abort: with `respond`
				// silent whenever the abort had run, neither was written, in 3 runs
				// of 3 (bun 1.4.0, measured 2026-09-29 and again 2026-09-30). They
				// are written because `respond` is silent only for a failure the
				// abort caused, which this is not, whenever it lands: both, in 3
				// runs of 3, the input cancelled at once (bun 1.4.0, measured
				// 2026-09-30; OW-nuzoto). Until OW-nuzoto a timer held the cancel
				// back so that the replies won. Under node they win anyway, and the
				// vitest case passes either way: only
				// `resources/probes/emacs_helper_no_server_probe.py` sees it.
				onDisconnect() {
					closeStream();
					if (stopped) return;
					flushNodes();
					stopped = true;
					if (!open) reject(new Error("could not reach the agentpane server"));
					void reader.cancel();
				},
				// The server frames its own JSON, so a frame that fails to parse is a
				// server bug, not a case to defend (D26 point 4). It has no session
				// to report against. Dropped, it costs a seq gap where a later event
				// under its handle detaches that one session, and where none follows,
				// as none follows an `ended`, an attachment Emacs is never told has
				// gone; a lost snapshot forms no view, so an attach held on it waits
				// for an `ended` or the helper's end.
				onMalformed() {},
			});
		}));

	const handlers: Handlers = {
		"sessions/list": async (params) => {
			await openStream();
			return api.listSessions(params?.cwd);
		},
		"sessions/preview": async ({ session }) => {
			const preview = await api.preview(session);
			// A preview is a stored session, never live, so nothing in it is running.
			return projectTranscript(previewMessages(preview.turns), false, render);
		},
		"sessions/create": (params) => api.createSession(params),
		"models/list": ({ backend }) => api.listModels(backend),
		"sessions/attach": async ({ session, token }) => {
			const attach: Attaching = { token, seen: new Set(), done: false };
			attaching.add(attach);
			try {
				await openStream();
				// Given up on while the open was pending: sent now, the attach would
				// spawn a session nobody waits on (OW-wukako). The error carries no
				// `data.status`, which would say the server refused it.
				if (attach.done) throw new Error("the attach was given up before it was sent");
				const summary = await api.attach(session);
				// The server writes the attach's snapshot to every connected stream
				// before it answers (`SessionManager.attach` in
				// src/server/http/session-manager.ts, then the GET in `sessionRoute`,
				// src/server/http/app.ts), and a stream that connects later is sent
				// an opening snapshot of every live session (`openEventStream`), but
				// the stream and the REST response are unordered (D2): on the fake
				// adapters the reply reached a direct client first in 23 and 28 of 40
				// attaches in two runs, 2026-09-28. An attach no snapshot has
				// answered by now is answered here, by the view the reducer holds
				// under the reply's handle: the session was live, or its snapshot
				// came before the reply, which no snapshot answers ahead of
				// (`introduce`). With no view, a
				// snapshot under the handle since the attach went out is taken for
				// this attach's own, which a gap took (`detachGapped`, OW-tifiva),
				// and nothing is recorded -- though it may have been one from
				// elsewhere, and this attach's own still on its way, which
				// `detachGapped` names; else
				// the snapshot is on its way, and the reply waits for it, so that it
				// never reaches Emacs ahead of the snapshot that attaches the buffer.
				// The wait ends with that snapshot (`introduce`), a detach or close
				// carrying this attach's token (`forget`), an `ended` under the
				// handle (`end`), or the helper's end. The attach is entered before
				// the stream's open, so such a detach while the open is pending ends
				// it too, and no REST call follows; and its REST call waits for the
				// open, so that the snapshot it broadcasts, and any `ended` under
				// its handle, reach this client (`openStream`).
				if (!attach.done) {
					const view = state.sessions[summary.handle];
					if (view) answer(attach, view, summary.handle);
					else if (!attach.seen.has(summary.handle) && !stopped) {
						attach.handle = summary.handle;
						await new Promise<void>((resolve) => (attach.release = resolve));
					}
				}
				return summary;
			} finally {
				attaching.delete(attach);
			}
		},
		// `handle` is dropped before the rest is spread into the HTTP body.
		"sessions/prompt": async ({ session, handle: _handle, ...body }) => {
			await api.prompt(session, body);
			return null;
		},
		"sessions/abort": async ({ session }) => {
			await api.abort(session);
			return null;
		},
		"sessions/compact": async ({ session }) => {
			await api.compact(session);
			return null;
		},
		"sessions/close": async ({ session, tokens }) => {
			await api.close(session);
			forget(tokens);
			return null;
		},
		"sessions/dismissError": async ({ session, errorId }) => {
			await api.dismissError(session, errorId);
			return null;
		},
		// Emacs no longer shows the session, and nothing more: unlike `close`,
		// the session goes on running on the server.
		"sessions/detach": async ({ tokens }) => {
			forget(tokens);
			return null;
		},
		"sessions/setModel": async ({ session, model }) => {
			await api.setModel(session, model);
			return null;
		},
		"sessions/setEffort": async ({ session, effort }) => {
			await api.setEffort(session, effort);
			return null;
		},
		"sessions/forkPoints": ({ session }) => api.forkPoints(session),
		"sessions/fork": ({ session, handle: _handle, ...body }) => api.fork(session, body),
	};

	const respond = async (request: JsonRpcRequest): Promise<void> => {
		const { id, method } = request;
		if (id === undefined || id === null) return; // A notification from Emacs: nothing to answer, and none is defined.
		const handler = (handlers as Record<string, (params: unknown) => Promise<unknown>>)[method ?? ""];
		if (!handler) {
			write(encodeFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${JSON.stringify(method)}` } }));
			return;
		}
		try {
			const result = await handler(request.params);
			write(encodeFrame({ jsonrpc: "2.0", id, result }));
		} catch (error: unknown) {
			// Aborted by this helper's teardown: no reply; see `runHelper`.
			if (abortedHere(error)) return;
			write(encodeFrame({ jsonrpc: "2.0", id, error: toRpcError(error) }));
		}
	};

	const decoder = new FrameDecoder();
	for (;;) {
		const { done, value: chunk } = await reader.read();
		if (done) break;
		for (const message of decoder.push(chunk)) void respond(message as JsonRpcRequest);
	}

	stopped = true;
	for (const attach of attaching) abandon(attach);
	clearTimeout(flushTimer);
	waiting.clear();
	closeStream();
	inFlight.abort();
}

function toRpcError(error: unknown): { code: number; message: string; data?: unknown } {
	if (error instanceof ApiClientError) {
		return {
			code: error.status,
			message: error.message,
			data: { status: error.status, error: error.code, detail: error.detail },
		};
	}
	return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}
