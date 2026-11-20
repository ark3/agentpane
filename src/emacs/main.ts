/**
 * The Emacs helper's entry point: the Bun binding, and nothing else
 * (OW-refibu).
 *
 *     bun run src/emacs/main.ts [base-url]
 *
 * Run from source the way `src/server/index.ts` is; no build, no binary. It
 * speaks JSON-RPC 2.0 with `Content-Length` framing on stdin and stdout, the
 * wire `jsonrpc-process-connection` in Emacs's bundled `jsonrpc.el` speaks,
 * and is a client of the agentpane server at `base-url`, defaulting to
 * loopback on `DEFAULT_PORT`. One helper per Emacs session, holding one
 * socket and serving every buffer in that Emacs (D2, D31).
 *
 * Everything with behaviour lives in `helper.ts` behind injectable streams
 * and is tested there in node; this file only decides what they are wired
 * to. The api client hands `openSocket` the socket's path, so the base URL
 * is prefixed here, its scheme moved to `ws:`; and the token is read from
 * its file for the `hello` (`token.ts`). Loading the markdown renderer takes
 * about a second, so it happens before the first frame is read rather than
 * at the first text part.
 */

import type { SocketLike } from "$client/api.ts";
import { DEFAULT_PORT } from "$shared/protocol.ts";
import { runHelper } from "./helper.ts";
import { loadRenderer } from "./render.ts";
import { readApiToken } from "./token.ts";

const base = (process.argv[2] ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "").replace(/^http/, "ws");

const render = await loadRenderer();
await runHelper({
	input: Bun.stdin.stream(),
	write: (frame) => void process.stdout.write(frame),
	openSocket: (path) => new WebSocket(`${base}${path}`) as unknown as SocketLike,
	token: () => readApiToken(),
	render,
});
