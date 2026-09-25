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
 * the attach reply. `sessions/changed` is unfiltered.
 *
 * Every per-session notification carries the session's `handle` (D24,
 * OW-suyinu), taken from the raw event being answered, or from the attach
 * reply's summary for what `sessions/attach` says itself. Requests accept one
 * beside `session` and send it nowhere; `emacs/agentpane.el` sends none, so
 * `sessions/detach` and `sessions/close` find the handle from the ref Emacs
 * was last told for it. The
 * wire to Emacs is still keyed by ref: `session/renamed` goes out for every
 * `renamed` under an attached handle until agentpane-mode keys by the handle
 * (OW-danifa) and the event leaves the wire (OW-mofuho). The hand-rolled
 * reader in `sse.ts` does not retry, so a drop is reopened after
 * `reconnectDelayMs`, and every open after the first emits
 * `sessions/changed`: a listing change while the stream was down is gone
 * (D21).
 */

import { ApiClientError, createAgentpaneApi, type ApiOptions } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { initialClientState, reduceServerEvent, type ClientState, type SessionView } from "$client/session-state.ts";
import { sessionKey, type ServerEvent, type SessionRef } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { projectTranscript, projectUpsert, type Render } from "./nodes.ts";
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

/**
 * Runs until `input` ends; then closes the stream, aborts every request still
 * waiting on the server, and resolves. Each request is answered detached from
 * the read loop, so without the abort a server that never answers holds its
 * socket, and Bun's event loop and the process with it, open past the end of
 * `input` (OW-kofuda). No api method passes a signal of its own.
 */
export async function runHelper(options: HelperOptions): Promise<void> {
	const { render, write } = options;
	const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const inFlight = new AbortController();
	const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		options.fetch(input, { ...init, signal: inFlight.signal })) as typeof globalThis.fetch;
	const api = createAgentpaneApi({ fetch, openEvents: options.openEvents });

	let state: ClientState = initialClientState();
	/** Handle of each session Emacs has attached -> the `sessionKey` of the ref it last told Emacs, which is the one Emacs names it by. */
	const attached = new Map<string, string>();
	/** `sessionKey`s of attaches no event or reply has yet given a handle. */
	const pending = new Set<string>();
	let connection: ReturnType<typeof api.connect> | null = null;
	let opens = 0;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

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

	const notifySnapshot = (view: SessionView, handle: string | undefined): void => {
		notify({
			method: "session/snapshot",
			params: {
				...statusOf(view, handle),
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
		attached.set(handle, sessionKey(told));
		return true;
	};

	const onEvent = (event: ServerEvent): void => {
		const before = state;
		const result = reduceServerEvent(before, event);
		state = result.state;
		if (result.refreshSessions) notify({ method: "sessions/changed" });
		for (const { ref } of result.recover) api.attach(ref).catch(() => undefined);
		if (event.type === "sessions-changed") return;

		// Before the `state === before` return below, which every `renamed`
		// takes: the reducer's arm is a no-op, and agentpane-mode still re-keys
		// on the notification (OW-danifa). A pending attach on the old ref moves
		// here, as it would have been re-keyed by ref.
		if (event.type === "renamed") {
			if (!isAttached(event.handle, event.from, event.session)) return;
			notify({ method: "session/renamed", params: { from: event.from, to: event.session, handle: event.handle } });
			return;
		}
		if (state === before) return;

		const { handle } = event;
		// A ref names one live session, and a snapshot is what introduces one
		// under a new handle -- a restarted server's, or the one another
		// client's re-attach minted -- after which the reducer holds no other
		// view of that ref. An attachment Emacs knows by that ref follows it,
		// as it did when this set was keyed by ref.
		if (event.type === "snapshot" && !attached.has(handle)) {
			const key = sessionKey(event.session);
			const held = [...attached].find(([, told]) => told === key);
			if (held !== undefined) {
				attached.delete(held[0]);
				attached.set(handle, key);
			}
		}
		if (!isAttached(handle, event.session, event.session)) return;
		const view = state.sessions[handle]!;
		switch (event.type) {
			case "snapshot":
				notifySnapshot(view, handle);
				return;
			case "upsert": {
				const previous = before.sessions[handle]!;
				const node = projectUpsert(previous.messages, event.index, event.message, view.isStreaming, render);
				notify({ method: "session/node", params: { session: view.ref, handle, node } });
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
	 * Stop telling Emacs about the session `session` names. It sends a ref and
	 * no handle, which resolves to the attached handle Emacs was last told that
	 * ref for; an attach still waiting for a handle is dropped by the ref it
	 * asked for.
	 */
	const forget = (session: SessionRef): void => {
		const key = sessionKey(session);
		pending.delete(key);
		for (const [handle, told] of attached) if (told === key) attached.delete(handle);
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
				// for with no `renamed` reaching this stream: an attach through an
				// alias an earlier rename left behind answers the new ref and
				// broadcasts only its snapshot, and the `renamed` a first start
				// broadcasts misses a stream the server has not yet registered, whose
				// opening snapshot then carries the new ref alone (`SessionManager`'s
				// `attach` and `#rename`, src/server/http/session-manager.ts).
				// Filtered by the asked-for key, that snapshot was dropped, so the
				// rename is said here, before the reply, with the snapshot the reducer
				// holds for the new ref if one has arrived; one still on its way is
				// forwarded when it does. Both carry the summary's handle, and the
				// attach moves from the ref it asked for onto it. An attach no longer
				// pending was moved already, by an event under the handle that
				// carried the asked-for ref -- a `renamed` from it among them -- or
				// dropped by a `sessions/detach` sent while this attach was in
				// flight, which a reply that lands after it must not undo.
				if (pending.delete(key)) {
					attached.set(summary.handle, sessionKey(summary.ref));
					if (sessionKey(summary.ref) !== key) {
						notify({ method: "session/renamed", params: { from: session, to: summary.ref, handle: summary.handle } });
						const view = state.sessions[summary.handle];
						if (view) notifySnapshot(view, summary.handle);
					}
				}
				return summary;
			} catch (error: unknown) {
				forget(session);
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
		"sessions/close": async ({ session }) => {
			await api.close(session);
			forget(session);
			return null;
		},
		"sessions/dismissError": async ({ session, message }) => {
			await api.dismissError(session, message);
			return null;
		},
		// Emacs no longer shows the session, and nothing more: unlike `close`,
		// the session goes on running on the server.
		"sessions/detach": async ({ session }) => {
			forget(session);
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
