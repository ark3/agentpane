/**
 * Server entry point.
 *
 * Owned by the transport workstream (DESIGN D2/D3). This is a placeholder that
 * proves the scaffold runs; replace it with the real SSE + REST server under
 * `src/server/http/`.
 */
import { DEFAULT_PORT } from "../shared/protocol.ts";

const port = Number(process.env.PORT ?? DEFAULT_PORT);

// Loopback only (D8).
Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch() {
		return new Response("agentpane: scaffold only\n", {
			headers: { "content-type": "text/plain" },
		});
	},
});

console.log(`agentpane listening on http://127.0.0.1:${port}`);
