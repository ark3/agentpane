/**
 * Dump one stored session as Emacs nodes (OW-mutufa).
 *
 *     bun run src/emacs/dump-nodes.ts <backend>/<id> > /tmp/nodes.json
 *
 * Fetches the read-only preview from the agentpane server on loopback, stamps
 * the turns the way the browser does, runs the projection with the browser's
 * renderer from `render.ts`, and writes the node array as JSON to stdout. A
 * script, not a module: nothing imports it and no test covers it; its
 * verification is running it against a real session.
 *
 * The argument splits on the first slash only. Codex and Claude ids carry no
 * slash, but a Pi id is an absolute path and is nothing but slashes.
 */

import { createAgentpaneApi } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { DEFAULT_PORT, type BackendId } from "$shared/protocol.ts";
import { projectTranscript } from "./nodes.ts";
import { loadRenderer } from "./render.ts";

const arg = process.argv[2];
const slash = arg?.indexOf("/") ?? -1;
if (!arg || slash <= 0) {
	console.error("usage: bun run src/emacs/dump-nodes.ts <backend>/<id>");
	process.exit(2);
}

const ref = { backend: arg.slice(0, slash) as BackendId, id: arg.slice(slash + 1) };
const base = `http://127.0.0.1:${DEFAULT_PORT}`;
// Only ever called, never asked for Bun's `preconnect`, so the cast is safe.
const loopback = ((input: RequestInfo | URL, init?: RequestInit) =>
	fetch(`${base}${String(input)}`, init)) as typeof fetch;
const api = createAgentpaneApi({ fetch: loopback });

const render = await loadRenderer();
const preview = await api.preview(ref);
// A preview is a stored session, never live, so nothing in it is running.
const nodes = projectTranscript(previewMessages(preview.turns), false, render);
process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
