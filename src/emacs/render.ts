/**
 * The browser's markdown renderer, loaded outside a browser (OW-refibu).
 *
 * `$client/render/markdown.ts`'s `dompurify` import binds to
 * `globalThis.window` as the module is evaluated and, finding none under Bun
 * or node, installs a stub with no `addHook`, so `sanitize` throws
 * `DOMPurify.addHook is not a function` (measured, `dompurify 3.4.13`,
 * `bun 1.4.0`). So a jsdom window goes on the global first and the module is
 * loaded by dynamic import after it, never by a static one; `window` alone
 * suffices, since DOMPurify reads `document` and the DOM constructors off it.
 *
 * jsdom comes in through the `createRequire` that
 * `process.getBuiltinModule("node:module")` returns, not the one an import
 * of `node:module` gives: under vitest's `vmThreads` pool that is vitest's
 * own, whose loader chokes on jsdom's dependency `@exodus/bytes`, an ES
 * module in a CommonJS package (`Unexpected token 'export'` from
 * `html-encoding-sniffer`, measured 2026-09-22 under `vitest 3.2.7`,
 * `jsdom 30.0.1`; `server.deps.inline` did not help, the edge being a
 * `require`). The builtin's loads jsdom natively, and `dompurify`, loaded
 * through vitest's loader into the same context, reads the window off the
 * context's global. Bun has `process.getBuiltinModule` too, so one path
 * serves the helper, the dump script and the tests. jsdom ships no type
 * declarations and the repo carries no `@types/jsdom`, so it is typed here
 * by the one thing used.
 *
 * Measured 2026-09-22 under `bun 1.4.0` on the home server: loading takes
 * about 1.1s once, and then a text part costs about 0.5ms with little text
 * and about 2ms for a 2.3k-char compaction summary, DOMPurify's walk over
 * jsdom dominating; projecting a whole fixture transcript without rendering
 * takes 0.05ms. A streaming upsert renders only the node it replaces, so the
 * per-token cost never grows with the transcript.
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
