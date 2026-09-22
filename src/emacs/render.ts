/**
 * The browser's markdown renderer, loaded outside a browser (OW-refibu).
 *
 * `renderMarkdown` lives in `$client/render/markdown.ts`, whose `dompurify`
 * import binds to `globalThis.window` the moment the module is evaluated and,
 * finding none under Bun or node, installs a stub with no `addHook` -- so
 * `sanitize` throws `DOMPurify.addHook is not a function` (measured,
 * `dompurify 3.4.13`, `bun 1.4.0`). So a jsdom window goes on the global first
 * and the module is loaded by dynamic import after it, never by a static one;
 * `window` alone suffices, because DOMPurify reads `document` and the DOM
 * constructors off the window object rather than off further globals.
 *
 * jsdom comes in through `createRequire`, and through the one that
 * `process.getBuiltinModule("node:module")` returns rather than the one
 * `import { createRequire } from "node:module"` gives: under vitest's
 * `vmThreads` pool the imported `node:module` is vitest's own, and its loader
 * chokes on jsdom's dependency `@exodus/bytes`, an ES module shipped in a
 * CommonJS package (`Unexpected token 'export'` from
 * `html-encoding-sniffer`, measured 2026-09-22 under `vitest 3.2.7`,
 * `jsdom 30.0.1`; `server.deps.inline` did not help, because the offending
 * edge is a `require`). The builtin's `createRequire` loads jsdom natively,
 * the window it makes is a plain object, and `dompurify` -- loaded through
 * vitest's loader into the same context -- reads it off the context's global.
 * Bun has `process.getBuiltinModule` too, so one path serves the helper, the
 * dump script and the tests. jsdom ships no type declarations and the repo
 * carries no `@types/jsdom`, so it is typed here by the one thing used.
 *
 * Cost, measured 2026-09-22 under `bun 1.4.0` on the home server: loading
 * takes about 1.1s once (jsdom, marked, highlight.js), and after that each
 * text part costs about 0.5ms with little text and about 2ms for a 2.3k-char
 * compaction summary -- DOMPurify's walk over jsdom dominates, and the
 * projection without rendering is 0.05ms for a whole fixture transcript. A
 * snapshot renders every text part once; a streaming upsert renders only the
 * one node it replaces, so the per-token cost is that node's text and never
 * the transcript's length.
 */

import type { Render } from "./nodes.ts";

export async function loadRenderer(): Promise<Render> {
	const global = globalThis as { window?: unknown };
	if (global.window === undefined) {
		const { createRequire } = process.getBuiltinModule("node:module");
		const require = createRequire(import.meta.url);
		const { JSDOM } = require("jsdom") as { JSDOM: new (html: string) => { window: unknown } };
		global.window = new JSDOM("").window;
	}
	const { renderMarkdown } = await import("$client/render/markdown.ts");
	return renderMarkdown;
}
