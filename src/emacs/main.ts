/**
 * The Emacs helper's entry point: the Bun binding of `runHelper`, and
 * nothing else (OW-refibu); the head of `helper.ts` says why the split.
 *
 *     bun run src/emacs/main.ts [base-url]
 *
 * Run from source the way `src/server/index.ts` is; no build, no binary.
 * `base-url` defaults to loopback on `DEFAULT_PORT`. The api client hands
 * `openSocket` the socket's path, so the base URL is prefixed here, its
 * scheme moved to `ws:`. Loading the markdown renderer takes about a second,
 * so it happens before the first frame is read rather than at the first
 * text part.
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
