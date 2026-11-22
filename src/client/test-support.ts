/**
 * A socket and a scripted server for the tests of the clients that talk to
 * the server through `createAgentpaneApi` (D31): the api's own, the Emacs
 * helper's, the token's, the controller's and App's. Neither runs anything of
 * the real server; the server's own end is `openConnection` in
 * src/server/http/socket.ts, tested beside it.
 */

import { vi, type Mock } from "vitest";
import type {
	CommandName,
	Commands,
	LiveSessionSummary,
	ServerEvent,
	ServerFrame,
	SessionRef,
} from "$shared/protocol.ts";
import { sessionKey } from "$shared/protocol.ts";
import { ApiClientError, createAgentpaneApi, type AgentpaneApi, type ApiOptions, type SocketLike } from "./api.ts";

/** One socket: what the client sent, and the server's end driven by hand. */
export class FakeSocket implements SocketLike {
	readonly sent: Record<string, unknown>[] = [];
	/** What the client closed it with, if it did. */
	closedWith: { code?: number; reason?: string } | null = null;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(
		readonly path: string,
		private readonly onSent: (socket: FakeSocket, frame: Record<string, unknown>) => void = () => {},
	) {}

	send(data: string): void {
		const frame = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(frame);
		this.onSent(this, frame);
	}

	close(code?: number, reason?: string): void {
		this.closedWith = { code, reason };
	}

	// -- the server's end ---------------------------------------------------

	open(): void {
		this.onopen?.();
	}

	deliver(frame: ServerFrame | string): void {
		this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
	}

	emit(event: ServerEvent): void {
		this.deliver({ type: "event", event });
	}

	/** The server closing the socket, or the socket failing. */
	drop(code = 1006, reason = ""): void {
		this.onclose?.({ code, reason });
	}

	/** The command frames the client sent, its `hello` left out. */
	commands(): Record<string, unknown>[] {
		return this.sent.filter((frame) => frame["cmd"] !== "hello");
	}
}

/**
 * How the scripted server answers a command: with its result, or by
 * throwing. An `ApiClientError` is the refusal, its code, detail, fork and
 * attached carried; any other error is answered `internal_error` with its
 * message, as the real server answers one it did not expect. `server` is
 * there for a command that emits events before it replies, as the real one
 * writes everything a command caused before its reply (D31 point 3).
 */
export type Script = {
	[K in CommandName]?: (params: Commands[K]["params"], server: SocketServer) => Commands[K]["result"] | Promise<Commands[K]["result"]>;
};

/** A command's result, which a command answering null may leave out, as the server writes it null. */
type Result<K extends CommandName> = Commands[K]["result"] extends null ? null | void : Commands[K]["result"];
type Run<K extends CommandName> = (params: Commands[K]["params"]) => Result<K> | Promise<Result<K>>;

/** The snapshot event, whose fields a test may set; the rest are an idle, empty session's. */
export type SnapshotEvent = Extract<ServerEvent, { type: "snapshot" }>;

/** What the server holds of a live session, read off the events it wrote. */
interface Held {
	ref: SessionRef;
	seq: number;
	snapshot: SnapshotEvent;
	errorId: string | null;
}

export interface SocketServer {
	/** Every socket opened, the latest last. */
	readonly sockets: FakeSocket[];
	/** Every command the client sent, its `hello`s left out, in order. */
	readonly calls: { cmd: string; params: Record<string, unknown> }[];
	/**
	 * What each command runs, called with the frame's params alone: the
	 * script's entry, else the default below. A test overrides one with the
	 * mock's own methods and asserts on what it was sent.
	 *
	 * The defaults answer as an idle server holding nothing but what the
	 * events through it set up: attach, create and fork-and-prompt write the
	 * snapshot of the session they leave live before replying; a close writes
	 * its `ended`, a dismissal its `error-cleared`, a prompt that is admitted
	 * the `error-cleared` of the error it went over, and a compaction its
	 * `"requesting"`. A command naming a handle that is not live is refused
	 * `not_attached` (D31 point 9).
	 */
	readonly on: { [K in CommandName]: Mock<Run<K>> };
	/** While above zero, an open fails, closing 1006, and counts it down. */
	failing: number;
	/** While true, a socket opens only at `open()`. */
	holdOpen: boolean;
	/** The events the `hello`'s reply follows, as the opening snapshots. */
	opening: ServerEvent[];
	openSocket(path: string): FakeSocket;
	/** Open the latest socket, held by `holdOpen`. */
	open(): void;
	/** The real api, on this server's sockets. */
	api(options?: Omit<ApiOptions, "openSocket">): AgentpaneApi;
	/** Write an event on the latest socket, which must be up: the server writes nothing on a socket before its `hello` or after its close. */
	emit(event: ServerEvent): void;
	/** Close the latest socket from the server's end. */
	drop(code?: number, reason?: string): void;
	/**
	 * Leave `ref` live, as an attach does: write its snapshot, under the
	 * handle the server already holds it by or `serverHandle(ref)`, and
	 * answer the summary a reply carries. For a script that attaches.
	 */
	attached(ref: SessionRef, snapshot?: Partial<SnapshotEvent>, summary?: Partial<LiveSessionSummary>): LiveSessionSummary;
	/** The handle the server holds `ref` live under, if it does. */
	handleAt(ref: SessionRef): string | undefined;
}

/** The handle the scripted server mints for `ref`, opaque to a client (D24). */
export function serverHandle(ref: SessionRef): string {
	return `handle-${ref.backend}-${ref.id}`;
}

/** The summary of a live session, as an attach's reply carries it. */
export function liveSummary(ref: SessionRef, overrides: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
	return {
		ref,
		cwd: "/work",
		preview: null,
		createdAt: null,
		updatedAt: null,
		status: "attached",
		isStreaming: false,
		name: null,
		onDisk: true,
		handle: serverHandle(ref),
		...overrides,
	};
}

/** The snapshot of an idle, empty session under `handle`. */
export function snapshotEvent(ref: SessionRef, handle = serverHandle(ref), overrides: Partial<SnapshotEvent> = {}): SnapshotEvent {
	return {
		type: "snapshot",
		session: ref,
		handle,
		seq: 0,
		messages: [],
		isStreaming: false,
		compaction: null,
		model: null,
		effort: null,
		unrestoredModel: null,
		error: null,
		errorId: null,
		notices: [],
		...overrides,
	};
}

/** A server that opens each socket on the next microtask, answers its `hello` and runs `script`. */
export function socketServer(script: Script = {}): SocketServer {
	const held = new Map<string, Held>();
	const greeted = new WeakSet<FakeSocket>();
	const closed = new WeakSet<FakeSocket>();
	let forks = 0;

	/** Read what a written event tells the server it holds. */
	function track(event: ServerEvent): void {
		if (event.type === "sessions-changed") return;
		if (event.type === "ended") {
			held.delete(event.handle);
			return;
		}
		if (event.type === "snapshot") {
			held.set(event.handle, { ref: event.session, seq: event.seq, snapshot: event, errorId: event.errorId });
			return;
		}
		const session = held.get(event.handle);
		if (!session) return;
		session.ref = event.session;
		session.seq = event.seq;
		if (event.type === "status") {
			const { isStreaming, compaction, model, effort, unrestoredModel } = event;
			session.snapshot = { ...session.snapshot, isStreaming, compaction, model, effort, unrestoredModel };
		}
		if (event.type === "error") session.errorId = event.errorId;
		if (event.type === "error-cleared") session.errorId = null;
	}

	function live(handle: string): Held & { handle: string } {
		const session = held.get(handle);
		if (!session) throw new ApiClientError("not_attached", `no live session under handle ${handle}`);
		return { ...session, handle };
	}

	/** The address of the next event under `handle`. */
	function next(handle: string): { session: SessionRef; handle: string; seq: number } {
		const session = live(handle);
		return { session: session.ref, handle, seq: session.seq + 1 };
	}

	const defaults: { [K in CommandName]: Run<K> } = {
		hello: () => {
			throw new ApiClientError("bad_request", "this socket has already said hello");
		},
		"sessions/list": () => ({ sessions: [] }),
		"sessions/create": ({ backend }) => ({ session: server.attached({ backend, id: `created-${++forks}` }) }),
		"sessions/attach": ({ ref }) => ({ session: server.attached(ref) }),
		"sessions/preview": ({ ref }) => ({ ref, turns: [] }),
		"sessions/prompt": (params) => {
			let session: LiveSessionSummary | undefined;
			let handle = params.handle;
			if (handle === undefined) {
				session = server.attached(params.ref!);
				handle = session.handle;
			}
			const { errorId } = live(handle);
			const over = params.priorErrorId === undefined ? errorId : params.priorErrorId;
			if (errorId !== null && over === errorId) server.emit({ type: "error-cleared", ...next(handle) });
			return session ? { disposition: "started", session } : { disposition: "started" };
		},
		"sessions/abort": ({ handle }) => {
			live(handle);
			return { queued: [] };
		},
		"sessions/compact": ({ handle }) => {
			const { snapshot } = live(handle);
			const { isStreaming, model, effort, unrestoredModel } = snapshot;
			server.emit({ type: "status", ...next(handle), isStreaming, compaction: "requesting", model, effort, unrestoredModel });
			return null;
		},
		"sessions/dismissError": ({ handle, errorId }) => {
			if (live(handle).errorId === errorId) server.emit({ type: "error-cleared", ...next(handle) });
			return null;
		},
		"sessions/close": ({ ref }) => {
			const handle = server.handleAt(ref);
			if (handle !== undefined) {
				server.emit({ type: "ended", session: live(handle).ref, handle });
				server.emit({ type: "sessions-changed" });
			}
			return null;
		},
		"sessions/setModel": ({ handle }) => (live(handle), null),
		"sessions/setEffort": ({ handle }) => (live(handle), null),
		"sessions/setName": ({ handle }) => (live(handle), null),
		"sessions/forkPoints": ({ handle }) => (live(handle), { points: [], forkStopsTurn: false }),
		"sessions/forkAndPrompt": ({ handle }) => ({
			session: server.attached({ backend: live(handle).ref.backend, id: `fork-${++forks}` }),
			disposition: "started",
		}),
		"models/list": () => ({ models: [] }),
		"draft/edit": ({ text }) => ({ text }),
	};

	const on = Object.fromEntries(
		(Object.keys(defaults) as CommandName[]).map((cmd) => {
			const own = script[cmd] as ((params: unknown, server: SocketServer) => unknown) | undefined;
			const fallback = defaults[cmd] as (params: unknown) => unknown;
			return [cmd, vi.fn((params: unknown) => (own ? own(params, server) : fallback(params)))];
		}),
	) as unknown as SocketServer["on"];

	const server: SocketServer = {
		sockets: [],
		calls: [],
		on,
		failing: 0,
		holdOpen: false,
		opening: [],
		openSocket(path) {
			const socket = new FakeSocket(path, (from, frame) => void answer(from, frame));
			server.sockets.push(socket);
			const fails = server.failing > 0;
			if (fails) server.failing -= 1;
			if (fails) queueMicrotask(() => drop(socket, 1006, ""));
			else if (!server.holdOpen) queueMicrotask(() => socket.open());
			return socket;
		},
		open() {
			server.sockets.at(-1)!.open();
		},
		api(options = {}) {
			return createAgentpaneApi({ ...options, openSocket: (path) => server.openSocket(path) });
		},
		emit(event) {
			const socket = server.sockets.at(-1);
			if (!socket || !greeted.has(socket) || closed.has(socket) || socket.closedWith) {
				throw new Error(`the server writes nothing on a socket that is not up, and was asked to write a ${event.type}`);
			}
			track(event);
			socket.emit(event);
		},
		drop(code, reason) {
			drop(server.sockets.at(-1)!, code, reason);
		},
		attached(ref, snapshot = {}, summary = {}) {
			const handle = summary.handle ?? server.handleAt(ref) ?? serverHandle(ref);
			const before = held.get(handle);
			server.emit(snapshotEvent(snapshot.session ?? ref, handle, { ...before?.snapshot, seq: 0, ...snapshot }));
			return liveSummary(snapshot.session ?? ref, { ...summary, handle });
		},
		handleAt(ref) {
			for (const [handle, session] of held) if (sessionKey(session.ref) === sessionKey(ref)) return handle;
			return undefined;
		},
	};

	/** The socket closing; what the server holds outlives it, for a reconnect's opening snapshots to say. */
	function drop(socket: FakeSocket, code = 1006, reason = ""): void {
		closed.add(socket);
		socket.drop(code, reason);
	}

	async function answer(socket: FakeSocket, frame: Record<string, unknown>): Promise<void> {
		const { id, cmd, ...params } = frame as { id: string; cmd: CommandName } & Record<string, unknown>;
		if (cmd === "hello") {
			greeted.add(socket);
			for (const event of server.opening) {
				track(event);
				socket.emit(event);
			}
			socket.deliver({ type: "reply", id, ok: true, result: null });
			return;
		}
		server.calls.push({ cmd, params });
		const run = on[cmd] as unknown as ((params: unknown) => unknown) | undefined;
		try {
			if (!run) throw new ApiClientError("bad_request", `unknown command ${cmd}`);
			const result = await run(params);
			if (closed.has(socket)) return;
			socket.deliver({ type: "reply", id, ok: true, result: (result ?? null) as never });
		} catch (error: unknown) {
			if (closed.has(socket)) return;
			const refusal = error instanceof ApiClientError ? error : new ApiClientError("internal_error", error instanceof Error ? error.message : String(error));
			socket.deliver({
				type: "reply",
				id,
				ok: false,
				code: refusal.code,
				detail: refusal.detail ?? refusal.code,
				...(refusal.fork ? { fork: refusal.fork } : {}),
				...(refusal.attached ? { attached: refusal.attached } : {}),
			});
		}
	}

	return server;
}
