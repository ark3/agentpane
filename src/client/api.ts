/**
 * The client's one connection to the server: a WebSocket that carries every
 * command and query in, and their replies and every event out, in the order
 * the server wrote them (D31). The browser and the Emacs helper both talk to
 * the server through the `AgentpaneApi` this builds, each adding only its own
 * edge: the browser its reconnect and its token prompt, the helper its exit.
 *
 * One function handles what arrives, an event or a reply, in arrival order,
 * and does a frame's work before it returns (D31 point 4): an event reaches
 * `onEvent` there, and the `hello`'s reply `onOpen`. Settling a request's
 * promise is the one thing it defers, and needs nothing more: a reply's
 * handler writes no session state (D28), and may take the state it reads to
 * be at least as new as the reply (D31 point 3), which a later event handled
 * before the continuation only makes truer.
 *
 * How a request ends, beside its reply:
 *
 * - Never written, so it ran nothing: one made with no socket up, or still
 *   waiting for the socket to open when it closed, rejects with
 *   `ApiClientError` code `unreachable`; one whose frame is over the server's
 *   limit, which would have cost the whole socket (D31 point 8), with
 *   `frame_too_large`.
 * - Written and unanswered when the socket closed: `ConnectionLostError`,
 *   its outcome unknown (D31 point 6). At a close for a refused token the
 *   server ran nothing (D31 point 5), so each rejects with `unauthorized`
 *   instead.
 */

import {
	MAX_SOCKET_FRAME_BYTES,
	SOCKET_CLOSE,
	SOCKET_PATH,
	type AbortResponse,
	type ApiError,
	type CommandName,
	type Commands,
	type CreateSessionRequest,
	type EditDraftRequest,
	type EditDraftResponse,
	type ForkAndPromptRequest,
	type ForkAndPromptResponse,
	type ForkPointsResponse,
	type ModelInfo,
	type PromptRequest,
	type PromptResponse,
	type ServerEvent,
	type ServerFrame,
	type SessionPreviewResponse,
	type SessionRef,
	type LiveSessionSummary,
	type SessionSummary,
} from "$shared/protocol.ts";

export interface EventConnection {
	/**
	 * Close the socket from this end. Every request written to it and still
	 * out rejects as the connection lost, one held unsent as `unreachable`,
	 * and `onDisconnect` does not fire: the caller is the one leaving.
	 */
	close(): void;
}

export interface EventHandlers {
	onEvent(event: ServerEvent): void;
	/** The `hello` was answered: the opening snapshots have been handled, and the socket is up. */
	onOpen(): void;
	/**
	 * The socket closed, from the server's end or for want of one, or failed
	 * to open. Every request still out on it has been settled first (D31
	 * point 6); nothing reconnects but the caller.
	 */
	onDisconnect(): void;
	onMalformed(error: Error): void;
}

/** The part of a `WebSocket` this module uses, so a test can pass its own. */
export interface SocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	onerror: (() => void) | null;
}

export interface ApiOptions {
	/** Open a socket on the server's `path`; the default is the browser's `WebSocket` on its page's origin. */
	openSocket?: (path: string) => SocketLike;
	/**
	 * The API token, read at each connect and carried by its `hello`, the
	 * socket's first frame (D31 point 5). While it answers null an empty one
	 * is sent, which the server refuses.
	 */
	token?: () => string | null;
	/** Told of a socket closed for a refused token, before its requests reject. */
	onUnauthorized?: () => void;
	/** Told of a `hello` the server accepted, before `onOpen`. */
	onAuthorized?: () => void;
}

/** The server refused a request, or this module refused to send it; either way it ran nothing. */
export class ApiClientError extends Error {
	readonly code: string;
	readonly detail: string | undefined;
	/** The fork a fork-and-prompt created before it failed (`ApiError.fork`, D30). */
	readonly fork: ApiError["fork"];
	/** The session a prompt naming no handle attached before it was refused (`ApiError.attached`, D30). */
	readonly attached: ApiError["attached"];

	constructor(code: string, detail?: string, fork?: ApiError["fork"], attached?: ApiError["attached"]) {
		super(detail ?? code);
		this.name = "ApiClientError";
		this.code = code;
		this.detail = detail;
		this.fork = fork;
		this.attached = attached;
	}
}

/** A request was written and the socket closed before its reply: whether the server acted on it is unknown (D31 point 6). */
export class ConnectionLostError extends Error {
	constructor() {
		super("the connection to the agentpane server was lost");
		this.name = "ConnectionLostError";
	}
}

/**
 * Every command on a live session names the handle the client holds for it,
 * and is refused `not_attached` once that handle has ended (D31 point 9).
 * Attach, preview, create and the listing name a ref.
 */
export interface AgentpaneApi {
	listSessions(cwd?: string): Promise<SessionSummary[]>;
	createSession(body: CreateSessionRequest): Promise<LiveSessionSummary>;
	attach(ref: SessionRef): Promise<LiveSessionSummary>;
	/**
	 * Read-only, non-attaching transcript preview (OW-38): spawns nothing.
	 * `signal` abandons the read, which then rejects with its reason, and
	 * whose reply is ignored (OW-bilogo).
	 */
	preview(ref: SessionRef, signal?: AbortSignal): Promise<SessionPreviewResponse>;
	/**
	 * Names `body.handle` where given, and `ref` only where it is not (D30).
	 * Resolves with the body, which a fake may leave out for a prompt that
	 * started a turn, as the HTTP route once answered one; the body says a
	 * backend handled the prompt without starting a turn for it, though an
	 * extension's own work may still arrive as events (`PromptDisposition`,
	 * OW-dulipe). One that named no handle names the session it attached
	 * (`PromptRequest.handle`, D30); a refusal after that attach rejects with
	 * an `ApiClientError` whose `attached` names it.
	 */
	prompt(ref: SessionRef, body: PromptRequest): Promise<PromptResponse | void>;
	editDraft(body: EditDraftRequest): Promise<EditDraftResponse>;
	/**
	 * Resolves with the prompts the stop took out of the backend's queue,
	 * steered into the turn and not yet delivered (D16, OW-wisifo); a fake
	 * may resolve with nothing for a stop that took none.
	 */
	abort(handle: string): Promise<AbortResponse | void>;
	compact(handle: string): Promise<void>;
	/**
	 * Kill this session's subprocess and drop it from the server's table
	 * (OW-tewave). The on-disk transcript survives, so the session comes back as
	 * `detached` in the next listing -- unless nothing had reached disk, as for
	 * a session created or forked here before its first turn, which leaves the
	 * listing altogether (`SessionSummary.onDisk`). Names the handle of the
	 * live session, refused `not_attached` once it has ended (D35 point 3).
	 */
	close(handle: string): Promise<void>;
	listModels(backend: SessionRef["backend"]): Promise<ModelInfo[]>;
	setModel(handle: string, model: string): Promise<void>;
	setEffort(handle: string, effort: string): Promise<void>;
	/** Name an attached session, written through to its backend (D27); the name returns in the listing. */
	setName(handle: string, name: string): Promise<void>;
	/**
	 * The points a session can be forked at (OW-hezidi), each naming the
	 * transcript index of the user message it forks at (OW-roveze).
	 *
	 * Not one per user message: a backend answers with the points it can
	 * actually cut at, and Codex cuts at turn granularity, so a message added by
	 * steering a running turn gets none. Nor is position the addressing scheme
	 * any more -- `ForkPoint.index` is, and it is an index into the same array
	 * `snapshot.messages` carries. `ForkPoint.id` is the backend's own cut
	 * token (a Pi entry id, a Codex turn id, a Claude Code store-line uuid) and
	 * `PaneMessage` carries none of them, which is why the index exists.
	 * Beside them, whether a fork of the session stops a running turn (D30).
	 */
	forkPoints(handle: string): Promise<ForkPointsResponse>;
	/**
	 * Fork at the user message `body.index` names, attach the fork and prompt
	 * it, as one server operation (D30). A refusal once the fork is attached
	 * rejects with an `ApiClientError` whose `fork` names it; one whose own
	 * start failed names none (D35 point 6).
	 */
	forkAndPrompt(handle: string, body: ForkAndPromptRequest): Promise<ForkAndPromptResponse>;
	/**
	 * Dismiss the session's turn error on the server, so no later snapshot
	 * brings it back (OW-bipume). `errorId` names the error dismissed, as the
	 * wire named the one shown; the server keeps a newer one (OW-jokoto).
	 */
	dismissError(handle: string, errorId: string): Promise<void>;
	/**
	 * Open a socket, which every request goes on from here; a request made
	 * while it is opening waits for it. Called again once the last has closed,
	 * which is the caller's reconnect.
	 */
	connect(handlers: EventHandlers): EventConnection;
}

type Params<K extends CommandName> = Commands[K]["params"];
type Result<K extends CommandName> = Commands[K]["result"];

interface Pending {
	resolve(result: unknown): void;
	reject(error: Error): void;
}

/** One socket, from its open to its close. */
interface Connection {
	socket: SocketLike;
	/** Frames written before the socket opened, sent behind the `hello` once it does. */
	queued: { id: string; text: string }[];
	opened: boolean;
	closed: boolean;
	pending: Map<string, Pending>;
}

const UNREACHABLE = "could not reach the agentpane server";
/** What every request held at a close for a refused token rejects with. */
export const REFUSED_TOKEN = "the server refused the API token";

export function createAgentpaneApi(options: ApiOptions = {}): AgentpaneApi {
	const openSocket = options.openSocket ?? defaultOpenSocket;
	const token = options.token ?? (() => null);
	const onUnauthorized = options.onUnauthorized ?? (() => {});
	const onAuthorized = options.onAuthorized ?? (() => {});
	let current: Connection | null = null;
	let lastId = 0;

	function request<K extends CommandName>(cmd: K, params: Params<K>, signal?: AbortSignal): Promise<Result<K>> {
		const id = String(++lastId);
		const text = JSON.stringify({ id, cmd, ...params });
		const connection = current;
		if (!connection || connection.closed) {
			return Promise.reject(new ApiClientError("unreachable", UNREACHABLE));
		}
		if (tooLarge(text)) {
			return Promise.reject(
				new ApiClientError("frame_too_large", `the request is over the server's limit of ${MAX_SOCKET_FRAME_BYTES / (1024 * 1024)} MB`),
			);
		}
		return new Promise<Result<K>>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			connection.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
			signal?.addEventListener("abort", () => {
				if (connection.pending.delete(id)) reject(signal.reason);
			});
			if (connection.opened) connection.socket.send(text);
			else connection.queued.push({ id, text });
		});
	}

	function connect(handlers: EventHandlers): EventConnection {
		const socket = openSocket(SOCKET_PATH);
		const connection: Connection = { socket, queued: [], opened: false, closed: false, pending: new Map() };
		current = connection;
		const helloId = String(++lastId);

		/** Settle everything still out as `closedBy` says, and forget the socket. */
		function settle(closedBy: "client" | "server", code?: number): void {
			if (connection.closed) return;
			connection.closed = true;
			if (current === connection) current = null;
			socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
			const unauthorized = code === SOCKET_CLOSE.unauthorized;
			if (unauthorized) onUnauthorized();
			const unsent = new Set(connection.queued.map((frame) => frame.id));
			for (const [id, pending] of connection.pending) {
				pending.reject(
					unauthorized
						? new ApiClientError("unauthorized", REFUSED_TOKEN)
						: unsent.has(id)
							? new ApiClientError("unreachable", UNREACHABLE)
							: new ConnectionLostError(),
				);
			}
			connection.pending.clear();
			connection.queued = [];
			if (closedBy === "server") handlers.onDisconnect();
		}

		socket.onopen = () => {
			connection.opened = true;
			socket.send(JSON.stringify({ id: helloId, cmd: "hello", token: token() ?? "" } satisfies { id: string; cmd: "hello" } & Params<"hello">));
			for (const frame of connection.queued) socket.send(frame.text);
			connection.queued = [];
		};
		socket.onmessage = ({ data }) => {
			const frame = parseServerFrame(data);
			if (!frame) {
				handlers.onMalformed(new Error(`a malformed frame from the server: ${String(data).slice(0, 200)}`));
				return;
			}
			if (frame.type === "event") {
				handlers.onEvent(frame.event);
				return;
			}
			if (frame.id === helloId) {
				onAuthorized();
				handlers.onOpen();
				return;
			}
			const pending = connection.pending.get(frame.id);
			if (!pending) return; // Abandoned by its signal.
			connection.pending.delete(frame.id);
			if (frame.ok) pending.resolve(frame.result);
			else pending.reject(new ApiClientError(frame.code, frame.detail, frame.fork, frame.attached));
		};
		socket.onclose = ({ code }) => settle("server", code);
		// An error is followed by a close, which settles; nothing to do here.
		socket.onerror = () => {};

		return {
			close() {
				settle("client");
				socket.close(1000, "the client is leaving");
			},
		};
	}

	return {
		async listSessions(cwd) {
			return (await request("sessions/list", cwd === undefined ? {} : { cwd })).sessions;
		},
		async createSession(body) {
			return (await request("sessions/create", body)).session;
		},
		async attach(ref) {
			return (await request("sessions/attach", { ref })).session;
		},
		preview(ref, signal) {
			return request("sessions/preview", { ref }, signal);
		},
		prompt(ref, { handle, ...body }) {
			return request("sessions/prompt", handle === undefined ? { ...body, ref } : { ...body, handle });
		},
		editDraft(body) {
			return request("draft/edit", body);
		},
		abort(handle) {
			return request("sessions/abort", { handle });
		},
		async compact(handle) {
			await request("sessions/compact", { handle });
		},
		async close(handle) {
			await request("sessions/close", { handle });
		},
		async listModels(backend) {
			return (await request("models/list", { backend })).models;
		},
		async setModel(handle, model) {
			await request("sessions/setModel", { handle, model });
		},
		async setEffort(handle, effort) {
			await request("sessions/setEffort", { handle, effort });
		},
		async setName(handle, name) {
			await request("sessions/setName", { handle, name });
		},
		forkPoints(handle) {
			return request("sessions/forkPoints", { handle });
		},
		forkAndPrompt(handle, body) {
			return request("sessions/forkAndPrompt", { handle, ...body });
		},
		async dismissError(handle, errorId) {
			await request("sessions/dismissError", { handle, errorId });
		},
		connect,
	};
}

/**
 * Whether `text` encodes past the server's frame limit. UTF-8 takes at most
 * three bytes for each UTF-16 unit, so a frame under a third of the limit in
 * units is not encoded to find out.
 */
function tooLarge(text: string): boolean {
	if (text.length * 3 <= MAX_SOCKET_FRAME_BYTES) return false;
	return new TextEncoder().encode(text).length > MAX_SOCKET_FRAME_BYTES;
}

function parseServerFrame(data: unknown): ServerFrame | null {
	if (typeof data !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const frame = parsed as Partial<ServerFrame>;
	if (frame.type === "event") return "event" in frame && typeof frame.event === "object" && frame.event !== null ? (frame as ServerFrame) : null;
	if (frame.type === "reply") return typeof frame.id === "string" && typeof frame.ok === "boolean" ? (frame as ServerFrame) : null;
	return null;
}

/** The browser's `WebSocket`, on the page's own origin. */
function defaultOpenSocket(path: string): SocketLike {
	const url = new URL(path, globalThis.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocket(url) as unknown as SocketLike;
}
