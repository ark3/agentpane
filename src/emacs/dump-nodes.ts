/**
 * Dump one stored session as Emacs nodes (OW-mutufa).
 *
 *     bun run src/emacs/dump-nodes.ts <backend>/<id> > /tmp/nodes.json
 *
 * Asks the agentpane server on loopback for the read-only preview, over the
 * socket as the helper does (D31), stamps
 * the turns the way the browser does, runs the projection with the browser's
 * renderer from `render.ts`, and writes the node array as JSON to stdout. A
 * script, not a module: nothing imports it and no test covers it; its
 * verification is running it against a real session.
 *
 * The argument splits on the first slash only. Codex and Claude ids carry no
 * slash, but a Pi id is an absolute path and is nothing but slashes.
 */

import { createAgentpaneApi, type SocketLike } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { DEFAULT_PORT, type BackendId } from "$shared/protocol.ts";
import { projectTranscript } from "./nodes.ts";
import { loadRenderer } from "./render.ts";
import { readApiToken } from "./token.ts";

const arg = process.argv[2];
const slash = arg?.indexOf("/") ?? -1;
if (!arg || slash <= 0) {
	console.error("usage: bun run src/emacs/dump-nodes.ts <backend>/<id>");
	process.exit(2);
}

const ref = { backend: arg.slice(0, slash) as BackendId, id: arg.slice(slash + 1) };
const base = `ws://127.0.0.1:${DEFAULT_PORT}`;
const api = createAgentpaneApi({
	openSocket: (path) => new WebSocket(`${base}${path}`) as unknown as SocketLike,
	token: () => readApiToken().value,
});
const connection = api.connect({ onEvent() {}, onOpen() {}, onDisconnect() {}, onMalformed() {} });

const render = await loadRenderer();
const preview = await api.preview(ref);
connection.close();
// A preview is a stored session, never live, so nothing in it is running.
const nodes = projectTranscript(previewMessages(preview.turns), false, render);
process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
