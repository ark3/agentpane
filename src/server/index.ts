/**
 * Server entry point: the Bun binding, and nothing else.
 *
 * Everything with behaviour lives in `src/server/http/`, behind a plain
 * `fetch(Request) => Response` and, for the socket (D31), `connect(send, end)`,
 * so the transport is testable in-process without opening a socket. This file
 * only decides *where* those are exposed and *what* they are wired to.
 *
 * The wiring is deliberately thin: production dependencies are composed once
 * here, while the transport remains independently testable behind its seams.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, MAX_SOCKET_FRAME_BYTES } from "../shared/protocol.ts";
import { loadApiToken } from "./api-token.ts";
import { createProductionDeps } from "./composition.ts";
import { createApp } from "./http/app.ts";
import type { Connection } from "./http/socket.ts";
import { createStaticHandler } from "./http/static.ts";

const port = Number(process.env.PORT ?? DEFAULT_PORT);

// Held only here and handed to `createApp`, never put in `process.env`, where
// every agent this server spawns would inherit it.
let apiToken: string;
try {
	apiToken = loadApiToken();
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/client");
const productionDeps = createProductionDeps();

const app = createApp({
	...productionDeps,
	apiToken,
	// Comfortably inside Bun's idle timeout below, and enough to notice a dead
	// stream without generating noticeable traffic.
	heartbeatMs: 15_000,
	// `Bun.file` is the only runtime-specific piece; the handler itself is
	// tested in `http/static.test.ts` against an injected filesystem.
	staticHandler: createStaticHandler(clientDir, (path) => {
		const file = Bun.file(path);
		return { exists: () => file.exists(), toResponse: () => new Response(file) };
	}),
});

// Loopback only (D8), which keeps the network out; the token above is what
// keeps out a local process that shares this loopback.
const server = Bun.serve<{ connection?: Connection }>({
	hostname: "127.0.0.1",
	port,
	// SSE streams are idle by design between turns; the default 10s would reap
	// them. The heartbeat above keeps well inside this. It does not reach an
	// upgraded socket (D31 point 8).
	idleTimeout: 60,
	fetch(request, server) {
		if (!app.isSocketRequest(request)) return app.fetch(request);
		const refusal = app.admitUpgrade(request);
		if (refusal) return refusal;
		if (server.upgrade(request, { data: {} })) return undefined;
		return new Response("this path takes a WebSocket upgrade", { status: 426, headers: { upgrade: "websocket" } });
	},
	// The socket beside the routes (D31). Its limits are set rather than
	// inherited (D31 point 8): the default pings keep an idle socket open, so
	// there is no heartbeat of ours; a frame past `maxPayloadLength` closes the
	// socket, which is why a client refuses a prompt over it before sending;
	// and a socket buffered past `backpressureLimit` is closed rather than left
	// to drop frames, a reply among them, so its client detaches and
	// reconnects (D31 point 6). The limit is set above the largest frame the
	// server may send, `MAX_SOCKET_FRAME_BYTES` echoed in an upsert with
	// room, so that one large snapshot alone does not close it.
	websocket: {
		maxPayloadLength: MAX_SOCKET_FRAME_BYTES,
		backpressureLimit: 64 * 1024 * 1024,
		closeOnBackpressureLimit: true,
		open(ws) {
			ws.data.connection = app.connect(
				(frame) => {
					ws.send(frame);
				},
				(code, reason) => ws.close(code, reason),
			);
		},
		message(ws, message) {
			// A binary frame is no JSON text, and reads as a bad frame.
			ws.data.connection?.receive(typeof message === "string" ? message : "");
		},
		close(ws) {
			ws.data.connection?.close();
		},
	},
});

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		// A second Ctrl-C means the user is done waiting. Without this, a
		// shutdown that stalls on an adapter is a terminal you have to kill from
		// another one.
		if (shuttingDown) process.exit(130);
		shuttingDown = true;
		void (async () => {
			try {
				// Explicit shutdown is one of exactly two things that kills an agent
				// subprocess; a dropped browser connection is not the other.
				await app.close();
				await server.stop(true);
			} catch (err) {
				console.error("shutdown did not complete cleanly:", err);
			} finally {
				process.exit(0);
			}
		})();
	});
}

console.log(`agentpane listening on http://127.0.0.1:${port}`);
