/**
 * A socket and a scripted server for the tests of the clients that talk to
 * the server through `createAgentpaneApi` (D31): the api's own, the Emacs
 * helper's and the token's. Neither runs anything of the real server; the
 * server's own end is `openConnection` in src/server/http/socket.ts, tested
 * beside it.
 */

import type { CommandName, Commands, ServerEvent, ServerFrame } from "$shared/protocol.ts";
import { ApiClientError, type SocketLike } from "./api.ts";

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
 * throwing an `ApiClientError`, whose code, detail, fork and attached the
 * refusal carries. `server` is there for a command that emits events before
 * it replies, as the real one writes everything a command caused before
 * its reply (D31 point 3).
 */
export type Script = {
	[K in CommandName]?: (params: Commands[K]["params"], server: SocketServer) => Commands[K]["result"] | Promise<Commands[K]["result"]>;
};

export interface SocketServer {
	/** Every socket opened, the latest last. */
	readonly sockets: FakeSocket[];
	/** Every command the client sent, its `hello`s left out, in order. */
	readonly calls: { cmd: string; params: Record<string, unknown> }[];
	/** While above zero, an open fails, closing 1006, and counts it down. */
	failing: number;
	/** The events the `hello`'s reply follows, as the opening snapshots. */
	opening: ServerEvent[];
	openSocket(path: string): FakeSocket;
	emit(event: ServerEvent): void;
	/** Close the latest socket from the server's end. */
	drop(code?: number, reason?: string): void;
}

/** A server that opens each socket on the next microtask, answers its `hello` and runs `script`. */
export function socketServer(script: Script = {}): SocketServer {
	const server: SocketServer = {
		sockets: [],
		calls: [],
		failing: 0,
		opening: [],
		openSocket(path) {
			const socket = new FakeSocket(path, (from, frame) => void answer(from, frame));
			server.sockets.push(socket);
			const fails = server.failing > 0;
			if (fails) server.failing -= 1;
			queueMicrotask(() => (fails ? socket.drop(1006) : socket.open()));
			return socket;
		},
		emit(event) {
			server.sockets.at(-1)!.emit(event);
		},
		drop(code, reason) {
			server.sockets.at(-1)!.drop(code, reason);
		},
	};

	async function answer(socket: FakeSocket, frame: Record<string, unknown>): Promise<void> {
		const { id, cmd, ...params } = frame as { id: string; cmd: CommandName } & Record<string, unknown>;
		if (cmd === "hello") {
			for (const event of server.opening) socket.emit(event);
			socket.deliver({ type: "reply", id, ok: true, result: null });
			return;
		}
		server.calls.push({ cmd, params });
		const run = script[cmd] as ((params: unknown, server: SocketServer) => unknown) | undefined;
		try {
			if (!run) throw new ApiClientError("bad_request", `unscripted command ${cmd}`);
			const result = await run(params, server);
			socket.deliver({ type: "reply", id, ok: true, result: (result ?? null) as never });
		} catch (error: unknown) {
			if (!(error instanceof ApiClientError)) throw error;
			socket.deliver({
				type: "reply",
				id,
				ok: false,
				code: error.code,
				detail: error.detail ?? error.code,
				...(error.fork ? { fork: error.fork } : {}),
				...(error.attached ? { attached: error.attached } : {}),
			});
		}
	}

	return server;
}
