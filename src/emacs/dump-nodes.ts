/**
 * Dump one stored session as Emacs nodes (OW-mutufa).
 *
 *     bun run src/emacs/dump-nodes.ts <backend>/<id> > /tmp/nodes.json
 *
 * Fetches the read-only preview from the agentpane server on loopback, stamps
 * the turns the way the browser does, runs the projection, and writes the node
 * array as JSON to stdout. A script, not a module: nothing imports it and no
 * test covers it; its verification is running it against a real session.
 *
 * The argument splits on the first slash only. Codex and Claude ids carry no
 * slash, but a Pi id is an absolute path and is nothing but slashes.
 *
 * For the rendering spike (OW-dekate) every text part also carries `html`: the
 * exact sanitized HTML the browser renders for that markdown, the string
 * `renderMarkdown` returns. That field is the spike's own addition, made here
 * and nowhere else -- it is not part of the node contract in `protocol.ts`,
 * and `projectTranscript` never produces it.
 *
 * `renderMarkdown` lives in `$client/render/markdown.ts`, whose `dompurify`
 * import binds to `globalThis.window` the moment the module is evaluated and,
 * finding none under Bun, installs a stub with no `addHook` -- so `sanitize`
 * throws `DOMPurify.addHook is not a function` (measured, `dompurify 3.4.13`,
 * `bun 1.4.2`). A jsdom window is put on the global first and the module is
 * loaded by dynamic import after it; `window` alone suffices, because
 * DOMPurify reads `document` and the DOM constructors off the window object
 * rather than off further globals. jsdom ships no type declarations and the
 * repo carries no `@types/jsdom`, so it comes in through `require`, which Bun
 * supports in an ES module, under a local type naming the one thing used.
 */

import { createAgentpaneApi } from "$client/api.ts";
import { previewMessages } from "$client/preview.ts";
import { DEFAULT_PORT, type BackendId } from "$shared/protocol.ts";
import { projectTranscript } from "./nodes.ts";
import type { NodePart, TextPart, TranscriptNode } from "./protocol.ts";

/** A text part with the browser's HTML beside its markdown -- the spike's shape, not the contract's. */
type SpikeTextPart = TextPart & { html: string };
type SpikePart = Exclude<NodePart, TextPart> | SpikeTextPart;
type SpikeNode = Omit<TranscriptNode, "parts"> & { parts: SpikePart[] };

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

// The window must exist before markdown.ts is evaluated; see the docblock.
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string) => { window: unknown } };
(globalThis as unknown as { window: unknown }).window = new JSDOM("").window;
const { renderMarkdown } = await import("$client/render/markdown.ts");

const preview = await api.preview(ref);
// A preview is a stored session, never live, so nothing in it is running.
const nodes: SpikeNode[] = projectTranscript(previewMessages(preview.turns), false).map((node) => ({
	...node,
	parts: node.parts.map((part): SpikePart =>
		part.type === "text" ? { ...part, html: renderMarkdown(part.text) } : part,
	),
}));
process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
