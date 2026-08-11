/**
 * Server entry point: the Bun binding, and nothing else.
 *
 * Everything with behaviour lives in `src/server/http/`, behind a plain
 * `fetch(Request) => Response`, so the transport is testable in-process without
 * opening a socket. This file only decides *where* that handler is exposed and
 * *what* it is wired to.
 *
 * The wiring is deliberately thin and currently empty: the adapter registry and
 * the session index are owned by other workstreams (`src/server/adapters/*`,
 * `src/server/sessions/`). Integration fills in the two literals below; nothing
 * else here changes.
 */

import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { createApp } from "./http/app.ts";
import { emptySessionIndex } from "./http/deps.ts";

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/client");

const app = createApp({
	// TODO(integration): `new FsSessionIndex()` from src/server/sessions/.
	index: emptySessionIndex,
	// TODO(integration): { pi: piAdapterFactory, codex: codexAdapterFactory }.
	adapters: {},
	// Comfortably inside Bun's idle timeout below, and enough to notice a dead
	// stream without generating noticeable traffic.
	heartbeatMs: 15_000,
	staticHandler: serveClient,
});

/** The built SPA, with the usual single-page fallback. Absent in dev -- Vite serves it. */
async function serveClient(request: Request): Promise<Response | null> {
	const { pathname } = new URL(request.url);
	if (request.method !== "GET" && request.method !== "HEAD") return null;

	// normalize() collapses `..`; join()ing the result keeps a crafted path
	// inside the bundle directory.
	const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
	const candidate = Bun.file(join(clientDir, rel));
	if (await candidate.exists()) return new Response(candidate);

	const index = Bun.file(join(clientDir, "index.html"));
	if (await index.exists()) return new Response(index);
	return null;
}

// Loopback only (D8). No auth token, no cookie, no localhost bypass -- none of
// it needs to exist once remote access is off the table.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	// SSE streams are idle by design between turns; the default 10s would reap
	// them. The heartbeat above keeps well inside this.
	idleTimeout: 60,
	fetch: app.fetch,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void (async () => {
			// Explicit shutdown is one of exactly two things that kills an agent
			// subprocess; a dropped browser connection is not the other.
			await app.close();
			await server.stop(true);
			process.exit(0);
		})();
	});
}

console.log(`agentpane listening on http://127.0.0.1:${port}`);
