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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { createApp } from "./http/app.ts";
import { emptySessionIndex } from "./http/deps.ts";
import { createStaticHandler } from "./http/static.ts";

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/client");

const app = createApp({
	// TODO(integration): the `SessionIndex` binding over src/server/sessions/.
	// That module exports `listSessions(opts)` only -- it has no `get(ref)`, and
	// `deps.ts` needs one (attach reads `cwd` from it). See the report.
	index: emptySessionIndex,
	// TODO(integration): { pi: new PiAdapterFactory(), codex: ... }.
	adapters: {},
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
