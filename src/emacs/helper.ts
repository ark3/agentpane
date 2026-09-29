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
 * `sessions/attach`, before that request's REST call, and it stays open
 * until the helper exits. At
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
 * handle the server let go of is dropped at the next `sessions-changed`,
 * and Emacs told (`dropDead` below, OW-yibijo). `sessions/changed` is
 * unfiltered.
 *
 * Every per-session notification carries the session's `handle` (D24,
 * OW-suyinu), taken from the raw event being answered, or from the attach
 * reply's summary for what `sessions/attach` says itself. Requests accept one
 * beside `session`, and send it nowhere; `sessions/detach` and
 * `sessions/close` stop the attachment under it, and without one the
 * attachment Emacs was last told that ref for (`forget` below).
 * agentpane-mode's detach carries its buffer's handle, and one without is
 * sent only from a buffer that sent an attach. No notification says a
 * rename: agentpane-mode keys its buffers by the handle (OW-danifa) and
 * takes the ref from any notification under it, as the reducer does, so the
 * snapshot under the handle that follows a rename on the server is all it
 * needs (OW-mofuho). What that is not enough for is the snapshot that
 * answers an attach, which must reach the buffer that asked: that buffer
 * holds no handle yet, and may hold another ref than the snapshot names,
 * or the ref of a session another buffer holds under that handle, and the
 * reply binds nothing. So each snapshot that answers an attach carries
 * `askedFor`, the ref the attach asked for, one such snapshot for each
 * attach it answers, and agentpane-mode binds it to the buffer that asked,
 * which takes the handle from it and absorbs a buffer already holding the
 * handle (`introduce` below, `agentpane--notified-buffer` and
 * `agentpane--attach-by` in emacs/agentpane.el). The hand-rolled
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
 * where it would answer a request that succeeded with an error, drop the
 * event stream from `onEvent`, or end the process from `dropDead`; and
 * either way the nodes held behind it would be lost.
 */

import { ApiClientError, createAgentpaneApi, type ApiOptions } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { initialClientState, reduceServerEvent, type ClientState, type SessionView } from "$client/session-state.ts";
import { sessionKey, type ServerEvent, type SessionRef } from "$shared/protocol.ts";
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
 * A `sessions/attach` not yet replied to (OW-rebawa): the ref it asked
 * for; the handle its reply named, once the reply waits on a snapshot
 * under it; every handle a snapshot came under since it went out; whether
 * a snapshot answered it or it was given up on; and, while its reply
 * waits, the function that sends it on.
 */
interface Attaching {
	asked: SessionRef;
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
 */
export async function runHelper(options: HelperOptions): Promise<void> {
	const { render } = options;
	const inFlight = new AbortController();
	const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		options.fetch(input, { ...init, signal: inFlight.signal })) as typeof globalThis.fetch;
	const api = createAgentpaneApi({ fetch, openEvents: options.openEvents });

	let state: ClientState = initialClientState();
	/** Handle of each session Emacs has attached -> the ref it last told Emacs, which is the one Emacs names it by. */
	const attached = new Map<string, SessionRef>();
	/** Every `sessions/attach` not yet replied to; see `Attaching`. */
	const attaching = new Set<Attaching>();
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

	/** Send `view` as a snapshot under `handle`, answering an attach of `asked` if given. */
	const notifySnapshot = (view: SessionView, handle: string, asked?: SessionRef): void => {
		notify({
			method: "session/snapshot",
			params: {
				...statusOf(view, handle),
				...(asked ? { askedFor: asked } : {}),
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
		notifySnapshot(view, handle, attach.asked);
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
	 * would reach a buffer that holds nothing for it. It answers an attach
	 * waiting on its handle, whose reply named it, and one whose reply has
	 * not come by the ref it asked for; each gets a snapshot of its own
	 * carrying that ref as `askedFor`, so one attaching an alias and one the
	 * session's own ref, both waiting on it, each reach their own buffer,
	 * which agentpane-mode then merges. Every attach waiting notes the
	 * handle, so a reply that finds no view under it can tell a snapshot a
	 * gap took (`detachGapped`) from one still on its way.
	 */
	const introduce = (event: Extract<ServerEvent, { type: "snapshot" }>): void => {
		const { handle } = event;
		const key = sessionKey(event.session);
		const view = state.sessions[handle]!;
		const answers = [...attaching].filter(
			(attach) => !attach.done && (attach.handle === undefined ? sessionKey(attach.asked) === key : attach.handle === handle),
		);
		for (const attach of attaching) attach.seen.add(handle);
		if (answers.length === 0) {
			if (!attached.has(handle)) return;
			attached.set(handle, event.session);
			notifySnapshot(view, handle);
			return;
		}
		for (const attach of answers) answer(attach, view, handle);
	};

	/** Stop telling Emacs anything under `held`. */
	const drop = (held: string): void => {
		attached.delete(held);
		for (const [key, node] of waiting) if (node.handle === held) waiting.delete(key);
	};

	/**
	 * Drop each attachment whose handle the server no longer holds, and tell
	 * Emacs so. Run on every `sessions-changed`, which the server sends once
	 * a close has taken the session out of its table, as well as at each
	 * attach and each turn's start and end, since nothing says a handle died:
	 * a close by another client leaves one that no event will ever come under
	 * again. The buffer still counts itself attached, so a prompt from it
	 * sends no attach, and the prompt route refuses it, since only an attach
	 * starts a session (D25). The unfiltered listing puts `handle` on every
	 * session the server holds (`SessionManager.list` in
	 * src/server/http/session-manager.ts), and a handle is never minted twice
	 * (D24), so one it lacks is gone for good.
	 * Where the session went is not worked out here: another name may reach
	 * it, or none, and only the server's `#names` knows. The buffer holding
	 * the handle lets go of it, and its own next attach, by the ref it holds,
	 * finds the session wherever it is now, the route answering the current
	 * handle and ref (`agentpane--notified-buffer` in emacs/agentpane.el).
	 * Re-attaching here instead would respawn the session the other client
	 * closed.
	 *
	 * Only a handle held when the listing was asked for can be dropped by its
	 * answer: one an attach answered meanwhile the listing may predate. And
	 * only while still held: a detach meanwhile has already told Emacs. Every
	 * event asks a listing of its own, none coalesced, since one in flight may
	 * predate the close that sent a later event; passes that overlap are
	 * safe, since a handle once gone is never minted again (D24) and each
	 * drops only what it held when it asked. A failed listing drops nothing,
	 * and the next `sessions-changed` asks again.
	 *
	 * An attach whose reply is held for a snapshot under a handle the listing
	 * lacks is abandoned the same way, on the same terms: the session went
	 * between the attach and its snapshot, which will not come, and its
	 * reply goes out with nothing recorded.
	 */
	const dropDead = async (): Promise<void> => {
		const held = [...attached.keys()];
		const holding = [...attaching].filter((attach) => attach.release !== undefined);
		if (held.length === 0 && holding.length === 0) return;
		let live: Set<string | undefined>;
		try {
			live = new Set((await api.listSessions()).map((summary) => summary.handle));
		} catch {
			return;
		}
		for (const handle of held) {
			const session = attached.get(handle);
			if (stopped || session === undefined || live.has(handle)) continue;
			drop(handle);
			notify({ method: "session/detached", params: { session, handle } });
		}
		for (const attach of holding) if (!attach.done && !live.has(attach.handle)) abandon(attach);
	};

	/**
	 * Detach the session whose `seq` gapped under `handle` (D25 point 5): its
	 * view goes, so no later event under the handle is applied to it, or gaps
	 * against it again, until a snapshot forms it afresh; and where Emacs
	 * attached it, the attachment goes and Emacs is told, as for a handle the
	 * server let go (`dropDead`). Nothing is attached on Emacs's behalf: an
	 * attach is what spawns, and one here would spawn again a session whose
	 * `sessions/close` is out. The buffer comes back on `g`. An attach whose
	 * snapshot is still on its way when the gap lands needs nothing here:
	 * that snapshot forms the view again and goes out as its first
	 * notification, unless the reply lands before it and finds that a
	 * snapshot under the handle came since the attach went out -- one from
	 * elsewhere, another client's attach or an opening snapshot, ahead of
	 * the server handling this attach -- which the reply takes for this
	 * attach's own, taken by the gap: it goes out with nothing recorded, and
	 * the snapshot that follows answers nothing. That takes a lost or
	 * malformed frame for the gap, and leaves the buffer not attached, which
	 * point 5 accepts. One whose snapshot arrived before the gap needs nothing
	 * either: sent, that snapshot attached the buffer, which the
	 * `session/detached` here lets go of before the reply; not sent, since
	 * it named another ref than the attach asked for, it recorded nothing,
	 * and the reply, finding no view under a handle a snapshot came under
	 * since the attach went out, sends nothing and records nothing either,
	 * rather than wait for a snapshot that will not come (OW-tifiva).
	 * Either way the attach ends with the buffer not attached.
	 */
	const detachGapped = (handle: string): void => {
		const sessions = { ...state.sessions };
		delete sessions[handle];
		state = { ...state, sessions };
		const session = attached.get(handle);
		if (session === undefined) return;
		drop(handle);
		notify({ method: "session/detached", params: { session, handle } });
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
		if (event.type === "sessions-changed") {
			void dropDead();
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
	 * Stop telling Emacs about the session `session` names. With a `handle`,
	 * the attachment under that handle goes, whatever ref Emacs names it by,
	 * which may be one from before a rename it has not heard (OW-wedeli).
	 * Without one, it goes by the ref Emacs was last told, as it must for a
	 * buffer whose attach never answered it: agentpane-mode sends that only
	 * from a buffer that sent an attach (`agentpane--detach`). Either way an
	 * attach of that ref no snapshot has answered is abandoned, its reply
	 * released if held, so no snapshot answers it later; that leaves any
	 * attachment another buffer holds under its handle alone.
	 */
	const forget = (session: SessionRef, handle: string | undefined): void => {
		const key = sessionKey(session);
		for (const attach of attaching) if (!attach.done && sessionKey(attach.asked) === key) abandon(attach);
		if (handle !== undefined) drop(handle);
		else for (const [held, told] of attached) if (sessionKey(told) === key) drop(held);
	};

	const closeStream = (): void => {
		connection?.close();
		connection = null;
	};

	const openStream = (): void => {
		if (stopped || connection) return;
		connection = api.connect({
			onEvent,
			onOpen() {},
			// A drop, or a failed first open, ends the helper (D25 point 4):
			// cancelling the input ends the read loop below as its end would,
			// and under `main.ts` the process with it, Emacs's end of stdin
			// still open (bun 1.4.0, measured 2026-09-28). A node the throttle
			// holds goes out first, since no timer will send it after the exit.
			onDisconnect() {
				closeStream();
				if (stopped) return;
				flushNodes();
				stopped = true;
				void reader.cancel();
			},
			// The server frames its own JSON; a frame that fails to parse has no
			// session to report against, and dropping it costs at most a seq gap,
			// which the next event detaches that one session for.
			onMalformed() {},
		});
	};

	const handlers: Handlers = {
		"sessions/list": (params) => {
			openStream();
			return api.listSessions(params?.cwd);
		},
		"sessions/preview": async ({ session }) => {
			const preview = await api.preview(session);
			// A preview is a stored session, never live, so nothing in it is running.
			return projectTranscript(previewMessages(preview.turns), false, render);
		},
		"sessions/create": (params) => api.createSession(params),
		"models/list": ({ backend }) => api.listModels(backend),
		"sessions/attach": async ({ session }) => {
			openStream();
			const attach: Attaching = { asked: session, seen: new Set(), done: false };
			attaching.add(attach);
			try {
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
				// came under another ref than the one asked for. With no view, a
				// snapshot under the handle since the attach went out is taken for
				// this attach's own, which a gap took (`detachGapped`, OW-tifiva),
				// and nothing is recorded -- though it may have been one from
				// elsewhere, and this attach's own still on its way, which
				// `detachGapped` names; else
				// the snapshot is on its way, and the reply waits for it, so that it
				// never reaches Emacs ahead of the snapshot that attaches the buffer.
				// The wait ends with that snapshot (`introduce`), a detach of the
				// asked-for ref (`forget`), a listing without the handle
				// (`dropDead`), or the helper's end. It is entered before the REST
				// call, not only once the stream has opened: a stream that opens
				// after the snapshot was broadcast gets the session's opening
				// snapshot instead.
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
		"sessions/close": async ({ session, handle }) => {
			await api.close(session);
			forget(session, handle);
			return null;
		},
		"sessions/dismissError": async ({ session, errorId }) => {
			await api.dismissError(session, errorId);
			return null;
		},
		// Emacs no longer shows the session, and nothing more: unlike `close`,
		// the session goes on running on the server.
		"sessions/detach": async ({ session, handle }) => {
			forget(session, handle);
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
