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
 * take a new ref from any event under it (D24), ask for recovery on a `seq`
 * gap, ignore an event for a view it does not hold (D2) -- and answers
 * `{ state, recover, refreshSessions }` and nothing more, so
 * the loop dispatches on the raw event's `type` beside that result. A `seq`
 * gap is healed the way `recover` in `$client/controller.ts` heals it: an
 * `api.attach`, after which the server broadcasts a fresh snapshot over the
 * stream, and that snapshot is what reaches Emacs.
 *
 * One stream, filtered. It opens lazily at the first `sessions/attach`,
 * before that attach's REST call, since the snapshot the attach broadcasts
 * and the REST response are unordered (D2), and it stays open. The server
 * sends an opening snapshot for every live session and broadcasts every
 * event to every client, so views Emacs never attached form in the reducer
 * too; notifications go out only for sessions Emacs attached through this
 * helper and has not detached or closed since. That set is kept here by
 * handle, like the reducer's views (OW-kimaya), so a rename moves nothing in
 * it; an attach waits in it under the ref it asked for, since it is entered
 * before the REST call (D2) and nothing has named a handle yet, and moves to
 * the handle with the first event under one that carries that ref, or with
 * the attach reply. An attachment whose session reaches the stream under a
 * new handle moves there once the server says the ref Emacs holds names that
 * handle now, and the snapshot that says so carries `movedFrom` (`reconcile`
 * below, OW-gusaru). `sessions/changed` is unfiltered.
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
 * needs (OW-mofuho). The one place that is not enough is an attach answered
 * under another ref than it asked for, whose snapshot under the new ref
 * reaches Emacs while the buffer that asked holds only the asked-for ref
 * and no handle, and whose reply cannot be relied on to reach it first:
 * jsonrpc.el 1.0.29 on Emacs 31.1 holds an async reply back as an "anxious
 * continuation" while a synchronous request is outstanding, and handles
 * notifications meanwhile (docs/MANUAL_TESTING.md). So the first snapshot
 * under that handle carries `askedFor`, the ref the attach asked for, and
 * agentpane-mode binds it to the buffer that asked, which takes the handle
 * from it (`askedFor` below, `agentpane--notified-buffer` in
 * emacs/agentpane.el). The hand-rolled
 * reader in `sse.ts` does not retry, so a drop is reopened after
 * `reconnectDelayMs`, and every open after the first emits
 * `sessions/changed`: a listing change while the stream was down is gone
 * (D21).
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
 * past it (OW-kofuda).
 */

import { ApiClientError, createAgentpaneApi, type ApiOptions } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { initialClientState, reduceServerEvent, type ClientState, type SessionView } from "$client/session-state.ts";
import { ROUTES, sessionKey, type LiveSessionResponse, type LiveSessionSummary, type ServerEvent, type SessionRef } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { locateUpsert, projectTarget, projectTranscript, type Render, type UpsertTarget } from "./nodes.ts";
import type { HelperNotification, HelperRequests } from "./protocol.ts";

export interface HelperOptions {
	input: ReadableStream<Uint8Array>;
	write: (frame: Uint8Array) => void;
	fetch: typeof fetch;
	openEvents: NonNullable<ApiOptions["openEvents"]>;
	render: Render;
	reconnectDelayMs?: number;
}

type Handlers = { [M in keyof HelperRequests]: (params: HelperRequests[M]["params"]) => Promise<HelperRequests[M]["result"]> };

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
/** The owner's first cut, 2026-09-25, to be judged by use (OW-jeruye). */
const NODE_INTERVAL_MS = 250;

/** An upsert not yet sent: what `session/node` will say, short of the rendering. */
interface HeldNode {
	session: SessionRef;
	handle: string;
	target: UpsertTarget;
	isStreaming: boolean;
}

/**
 * Runs until `input` ends; then closes the stream, aborts every request still
 * waiting on the server, and resolves. Each request is answered detached from
 * the read loop, so without the abort a server that never answers holds its
 * socket, and Bun's event loop and the process with it, open past the end of
 * `input` (OW-kofuda). No api method passes a signal of its own.
 */
export async function runHelper(options: HelperOptions): Promise<void> {
	const { render } = options;
	const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const inFlight = new AbortController();
	const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		options.fetch(input, { ...init, signal: inFlight.signal })) as typeof globalThis.fetch;
	const api = createAgentpaneApi({ fetch, openEvents: options.openEvents });

	let state: ClientState = initialClientState();
	/** Handle of each session Emacs has attached -> the ref it last told Emacs, which is the one Emacs names it by. */
	const attached = new Map<string, SessionRef>();
	/** `sessionKey`s of attaches no event or reply has yet given a handle. */
	const pending = new Set<string>();
	/**
	 * Handle of an attach answered under another ref than it asked for -> the
	 * ref it asked for, until the first snapshot under the handle carries it
	 * to Emacs as `askedFor`, or the attachment is forgotten. That snapshot is
	 * the first notification under the handle: the reducer forwards nothing
	 * for a view it does not hold, and only a snapshot introduces one.
	 */
	const askedFor = new Map<string, SessionRef>();
	let connection: ReturnType<typeof api.connect> | null = null;
	let opens = 0;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	/** Held nodes by handle and node index, in the order each was first held; a later upsert keeps its place. */
	const waiting = new Map<string, HeldNode>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushNodes = (): void => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		const nodes = [...waiting.values()];
		waiting.clear();
		for (const { session, handle, target, isStreaming } of nodes) {
			const notification: HelperNotification = {
				method: "session/node",
				params: { session, handle, node: projectTarget(target, isStreaming, render) },
			};
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

	/** `movedFrom` is the handle an attachment `reconcile` moved onto `handle` held before. */
	const notifySnapshot = (view: SessionView, handle: string | undefined, movedFrom?: string): void => {
		const asked = handle === undefined ? undefined : askedFor.get(handle);
		if (handle !== undefined) askedFor.delete(handle);
		notify({
			method: "session/snapshot",
			params: {
				...statusOf(view, handle),
				...(asked ? { askedFor: asked } : {}),
				...(movedFrom ? { movedFrom } : {}),
				nodes: projectTranscript(view.messages, view.isStreaming, render),
				error: view.error,
				requests: view.requests,
				notices: view.notices,
			},
		});
	};

	/**
	 * Whether Emacs attached the session `handle` names, moving a pending
	 * attach on `ref` onto it; if so, `told` is the ref the notification about
	 * to go out names.
	 */
	const isAttached = (handle: string, ref: SessionRef, told: SessionRef): boolean => {
		if (!attached.has(handle) && !pending.delete(sessionKey(ref))) return false;
		attached.set(handle, told);
		return true;
	};

	/** Stop telling Emacs anything under `held`. */
	const drop = (held: string): void => {
		attached.delete(held);
		askedFor.delete(held);
		for (const [key, node] of waiting) if (node.handle === held) waiting.delete(key);
	};

	/** The live session `ref` names now, by any of its names, or null; the route starts nothing. */
	const liveSummary = async (ref: SessionRef): Promise<LiveSessionSummary | null> => {
		const response = await fetch(ROUTES.live(ref), { method: "GET" });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`${ROUTES.live(ref)} answered ${response.status}`);
		return ((await response.json()) as LiveSessionResponse).session;
	};

	let reconciling = false;
	let reconcileAgain = false;
	/**
	 * Move each attachment onto the handle its session lives under now, asking
	 * the server, which alone knows every name a live session has (`#names`
	 * in src/server/http/session-manager.ts). Run on every snapshot under a
	 * handle no attachment holds, since that is how a session reaches this
	 * helper under a new handle -- a restarted server's, or the one another
	 * client's re-attach minted -- and the ref it carries may be one Emacs
	 * never heard: a re-attach elsewhere and then a rename of the re-attached
	 * container, in one outage of the stream, leave the session under a new
	 * handle and a new ref at once (OW-gusaru). Matching the snapshot's ref against the one last told
	 * Emacs, as this did until then, missed exactly that.
	 *
	 * The server is asked by the ref last told Emacs, which stays a name of
	 * the session's container for as long as the container lives, and names no
	 * other while it does. So an answer under another handle means the one
	 * held is gone: the attachment moves there, and the snapshot the reducer
	 * holds under it goes out carrying `movedFrom`, the handle the buffer
	 * holds, by which agentpane-mode finds the buffer however new the ref is
	 * to it (`agentpane--notified-buffer` in emacs/agentpane.el). Where the
	 * reducer holds no view under that handle yet, nothing moves: its
	 * snapshot, when it comes, runs this again. Where another attachment
	 * already holds it, this one is dropped, since that one is fed already.
	 * An answer that nothing live carries the ref moves nothing, and the next
	 * such snapshot asks again, so an attachment still follows its session
	 * once anyone attaches it again by a name the container keeps. A rename
	 * before a close elsewhere is not one: the closed container took the link
	 * between the ref told Emacs and the new one with it, and a re-attach by
	 * the new ref leaves the buffer frozen (D21). Nothing here attaches: the route only
	 * reads the server's table, so no session nobody asked to have running is
	 * started or resurrected.
	 *
	 * One pass at a time, and a snapshot during one asks for another after
	 * it, so no older answer lands after a newer one; each answer applies only
	 * while the attachment it was asked for still stands as it was asked.
	 */
	const reconcile = async (): Promise<void> => {
		if (reconciling) {
			reconcileAgain = true;
			return;
		}
		reconciling = true;
		try {
			do {
				reconcileAgain = false;
				await Promise.all(
					[...attached].map(async ([held, told]) => {
						const live = await liveSummary(told).catch(() => null);
						const current = attached.get(held);
						if (stopped || !live || live.handle === held) return;
						if (current === undefined || sessionKey(current) !== sessionKey(told)) return;
						if (attached.has(live.handle)) {
							drop(held);
							return;
						}
						const view = state.sessions[live.handle];
						if (!view) return;
						attached.delete(held);
						attached.set(live.handle, view.ref);
						const asked = askedFor.get(held);
						askedFor.delete(held);
						if (asked) askedFor.set(live.handle, asked);
						notifySnapshot(view, live.handle, held);
					}),
				);
			} while (reconcileAgain && !stopped);
		} finally {
			reconciling = false;
		}
	};

	const onEvent = (event: ServerEvent): void => {
		const before = state;
		const result = reduceServerEvent(before, event);
		state = result.state;
		if (result.refreshSessions) notify({ method: "sessions/changed" });
		for (const { ref } of result.recover) api.attach(ref).catch(() => undefined);
		if (event.type === "sessions-changed") return;

		if (state === before) return;

		const { handle } = event;
		if (event.type === "snapshot" && !attached.has(handle) && attached.size > 0) void reconcile();
		if (!isAttached(handle, event.session, event.session)) return;
		const view = state.sessions[handle]!;
		switch (event.type) {
			case "snapshot":
				notifySnapshot(view, handle);
				return;
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
				notify({ method: "session/error", params: { session: view.ref, handle, message: event.message } });
				return;
			case "notice":
				notify({ method: "session/notice", params: { session: view.ref, handle, notice: event.notice } });
				return;
			case "request":
				notify({ method: "session/request", params: { session: view.ref, handle, request: event.request } });
				return;
			case "request-resolved":
				notify({ method: "session/requestResolved", params: { session: view.ref, handle, requestId: event.requestId } });
				return;
		}
	};

	/**
	 * Stop telling Emacs about the session `session` names. With a `handle`,
	 * the attachment under that handle goes, whatever ref Emacs names it by,
	 * which may be one from before a rename it has not heard (OW-wedeli).
	 * Without one, it goes by the ref Emacs was last told, as it must for a
	 * buffer whose attach never answered it: agentpane-mode sends that only
	 * from a buffer that sent an attach (`agentpane--detach`), and matches an
	 * attach answered under another ref by the ref it asked for until its
	 * `askedFor` snapshot has gone out, since until then that buffer holds
	 * no handle. Either way an attach still waiting for a handle is dropped
	 * by the ref it asked for.
	 */
	const forget = (session: SessionRef, handle: string | undefined): void => {
		const key = sessionKey(session);
		pending.delete(key);
		if (handle !== undefined) drop(handle);
		else {
			for (const [held, told] of attached) if (sessionKey(told) === key) drop(held);
			for (const [held, asked] of askedFor) if (sessionKey(asked) === key) drop(held);
		}
	};

	const closeStream = (): void => {
		connection?.close();
		connection = null;
	};

	const openStream = (): void => {
		if (stopped || connection) return;
		connection = api.connect({
			onEvent,
			onOpen() {
				opens += 1;
				if (opens > 1) notify({ method: "sessions/changed" });
			},
			onDisconnect() {
				closeStream();
				if (stopped) return;
				reconnect = setTimeout(() => {
					reconnect = undefined;
					openStream();
				}, reconnectDelayMs);
			},
			// The server frames its own JSON; a frame that fails to parse has no
			// session to report against, and dropping it costs at most a seq gap,
			// which the next event heals.
			onMalformed() {},
		});
	};

	const handlers: Handlers = {
		"sessions/list": (params) => api.listSessions(params?.cwd),
		"sessions/preview": async ({ session }) => {
			const preview = await api.preview(session);
			// A preview is a stored session, never live, so nothing in it is running.
			return projectTranscript(previewMessages(preview.turns), false, render);
		},
		"sessions/create": (params) => api.createSession(params),
		"models/list": ({ backend }) => api.listModels(backend),
		"sessions/attach": async ({ session }) => {
			openStream();
			const key = sessionKey(session);
			pending.add(key);
			try {
				const summary = await api.attach(session);
				// The route's ref is authoritative and may differ from the one asked
				// for: an attach through an alias an earlier rename left behind
				// answers the new ref, and so does a first start that renamed a
				// `virtual` id, and the snapshot either broadcasts carries only the
				// new ref (`SessionManager`'s `attach` and `#rename`,
				// src/server/http/session-manager.ts). Filtered by the asked-for key,
				// that snapshot was dropped, so the attach moves onto the summary's
				// handle here and the snapshot the reducer holds under it goes out
				// now, before the reply; one still on its way is forwarded when it
				// arrives. Either names the ref asked for in `askedFor`, since until
				// it does no buffer holds that handle, and agentpane-mode may handle
				// the reply after it whatever the order here. Only for the first
				// attachment of the handle: where another already holds it, its
				// snapshots were never dropped, the buffer that attached it takes
				// what follows by that handle or by its own ref, and this attach's
				// reply merges the asking buffer into that one
				// (`agentpane--attached-as` and `agentpane--absorb` in
				// emacs/agentpane.el), as it did before the tag; a tag here would
				// also let a detach by this alias drop that buffer's attachment
				// (`forget` above). An attach
				// no longer pending was moved already, by an event under the handle
				// that carried the asked-for ref, which the buffer matched by that
				// ref, or dropped by a `sessions/detach` sent while this attach was in
				// flight, which a reply that lands after it must not undo.
				if (pending.delete(key)) {
					const first = !attached.has(summary.handle);
					attached.set(summary.handle, summary.ref);
					if (first && sessionKey(summary.ref) !== key) {
						askedFor.set(summary.handle, session);
						const view = state.sessions[summary.handle];
						if (view) notifySnapshot(view, summary.handle);
					}
				}
				return summary;
			} catch (error: unknown) {
				// Only this attach's wait: an attachment already held under a
				// handle for the same ref is another buffer's, or this one's from
				// before, and a failed attach takes neither away.
				pending.delete(key);
				throw error;
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
		"sessions/dismissError": async ({ session, message }) => {
			await api.dismissError(session, message);
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
		"requests/reply": async (params) => {
			await api.reply(params.requestId, params);
			return null;
		},
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
	const reader = options.input.getReader();
	for (;;) {
		const { done, value: chunk } = await reader.read();
		if (done) break;
		for (const message of decoder.push(chunk)) void respond(message as JsonRpcRequest);
	}

	stopped = true;
	if (reconnect !== undefined) clearTimeout(reconnect);
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
