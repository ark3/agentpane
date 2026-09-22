/**
 * The Emacs helper's entry point: the Bun binding, and nothing else
 * (OW-refibu).
 *
 *     bun run src/emacs/main.ts [base-url]
 *
 * Run from source the way `src/server/index.ts` is; no build, no binary. It
 * speaks JSON-RPC 2.0 with `Content-Length` framing on stdin and stdout, the
 * wire `jsonrpc-process-connection` in Emacs's bundled `jsonrpc.el` speaks,
 * and is a client of the agentpane HTTP API at `base-url`, defaulting to
 * loopback on `DEFAULT_PORT`. One helper per Emacs session, holding one
 * event stream and serving every buffer in that Emacs (D2).
 *
 * Everything with behaviour lives in `helper.ts` behind injectable streams
 * and is tested there in node; this file only decides what they are wired
 * to. The api client hands its `fetch` and `openEvents` relative routes, so
 * the base URL is prefixed inside the one fetch both are built on. The
 * event stream is the hand-rolled reader in `sse.ts`: `EventSource` is not a
 * global under `bun 1.4.0` (measured 2026-09-22; see that file). Loading
 * the markdown renderer takes about a second, so it happens before the
 * first frame is read rather than at the first text part.
 */

import { DEFAULT_PORT } from "$shared/protocol.ts";
import { runHelper } from "./helper.ts";
import { loadRenderer } from "./render.ts";
import { sseOpenEvents } from "./sse.ts";

const base = (process.argv[2] ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
// Only ever called, never asked for Bun's `preconnect`, so the cast is safe.
const loopback = ((input: RequestInfo | URL, init?: RequestInit) =>
	fetch(`${base}${String(input)}`, init)) as typeof fetch;

const render = await loadRenderer();
await runHelper({
	input: Bun.stdin.stream(),
	write: (frame) => void process.stdout.write(frame),
	fetch: loopback,
	openEvents: sseOpenEvents(loopback),
	render,
});
