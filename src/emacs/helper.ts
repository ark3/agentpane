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
 * applies every rule the browser learned -- re-key on `renamed`, ask for
 * recovery on a `seq` gap, ignore an event for a view it does not hold (D2)
 * -- and answers `{ state, recover, refreshSessions }` and nothing more, so
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
 * too; notifications go out only for refs Emacs attached through this
 * helper and have not detached or closed since, a set kept here and
 * re-keyed on `renamed`. `sessions/changed` is unfiltered. The hand-rolled reader in `sse.ts` does not retry, so a drop
 * is reopened after `reconnectDelayMs`, and every open after the first
 * emits `sessions/changed`: a listing change while the stream was down is
 * gone (D21).
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

/** Runs until `input` ends; then closes the stream and resolves. */
export async function runHelper(options: HelperOptions): Promise<void> {
	const { render, write } = options;
	const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
	const api = createAgentpaneApi({ fetch: options.fetch, openEvents: options.openEvents });

	let state: ClientState = initialClientState();
	const attached = new Set<string>();
	let connection: ReturnType<typeof api.connect> | null = null;
	let opens = 0;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const notify = (notification: HelperNotification): void => {
		write(encodeFrame({ jsonrpc: "2.0", ...notification }));
	};

	const statusOf = (view: SessionView) => ({
		session: view.ref,
		isStreaming: view.isStreaming,
		compaction: view.compaction ?? null,
		model: view.model,
	});

	const notifySnapshot = (view: SessionView): void => {
		notify({
			method: "session/snapshot",
			params: { ...statusOf(view), nodes: projectTranscript(view.messages, view.isStreaming, render) },
		});
	};

	const onEvent = (event: ServerEvent): void => {
		const before = state;
		const result = reduceServerEvent(before, event);
		state = result.state;
		if (result.refreshSessions) notify({ method: "sessions/changed" });
		for (const ref of result.recover) api.attach(ref).catch(() => undefined);
		if (event.type === "sessions-changed" || state === before) return;

		if (event.type === "renamed") {
			const fromKey = sessionKey(event.from);
			if (!attached.has(fromKey)) return;
			attached.delete(fromKey);
			attached.add(sessionKey(event.session));
			notify({ method: "session/renamed", params: { from: event.from, to: event.session } });
			return;
		}

		const key = sessionKey(event.session);
		if (!attached.has(key)) return;
		const view = state.sessions[key]!;
		switch (event.type) {
			case "snapshot":
				notifySnapshot(view);
				return;
			case "upsert": {
				const previous = before.sessions[key]!;
				const node = projectUpsert(previous.messages, event.index, event.message, view.isStreaming, render);
				notify({ method: "session/node", params: { session: view.ref, node } });
				return;
			}
			case "status":
				notify({ method: "session/status", params: statusOf(view) });
				return;
			case "error":
				notify({ method: "session/error", params: { session: view.ref, message: event.message } });
				return;
			case "request":
				notify({
					method: "session/error",
					params: {
						session: view.ref,
						message: `the agent sent a ${event.request.kind} request (${event.request.requestId}) that nothing in Emacs answers yet`,
					},
				});
				return;
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
			attached.add(key);
			try {
				const summary = await api.attach(session);
				// The route's ref is authoritative and may differ from the one asked
				// for with no `renamed` reaching this stream: an attach through an
				// alias an earlier rename left behind answers the new ref and
				// broadcasts only its snapshot, and the `renamed` a first start
				// broadcasts misses a stream the server has not yet registered, whose
				// opening snapshot then carries the new ref alone (`SessionManager`'s
				// `attach` and `#adoptRef`, src/server/http/session-manager.ts).
				// Filtered by the asked-for key, that snapshot was dropped, so the
				// rename is said here, before the reply, with the snapshot the reducer
				// holds for the new ref if one has arrived; one still on its way is
				// forwarded when it does. A key already gone was re-keyed by a
				// `renamed` that did arrive, or dropped by a `sessions/detach` sent
				// while this attach was in flight, which a reply that lands after it
				// must not undo.
				const next = sessionKey(summary.ref);
				if (next !== key && attached.has(key)) {
					attached.delete(key);
					attached.add(next);
					notify({ method: "session/renamed", params: { from: session, to: summary.ref } });
					const view = state.sessions[next];
					if (view) notifySnapshot(view);
				}
				return summary;
			} catch (error: unknown) {
				attached.delete(key);
				throw error;
			}
		},
		"sessions/prompt": async ({ session, ...body }) => {
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
			attached.delete(sessionKey(session));
			return null;
		},
		// Emacs no longer shows the session, and nothing more: unlike `close`,
		// the session goes on running on the server.
		"sessions/detach": async ({ session }) => {
			attached.delete(sessionKey(session));
			return null;
		},
		"sessions/setModel": async ({ session, model }) => {
			await api.setModel(session, model);
			return null;
		},
		"sessions/forkPoints": ({ session }) => api.forkPoints(session),
		"sessions/fork": ({ session, ...body }) => api.fork(session, body),
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
