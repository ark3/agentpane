/**
 * Serving the built SPA -- everything under `AppDeps.staticHandler`.
 *
 * It lives here rather than in `src/server/index.ts` so it can be tested: the
 * only Bun-specific part is opening a file, which is injected. Path resolution,
 * which is the part with a security property, is a pure function.
 *
 * Loopback only (D8), so there is no auth to get wrong -- but "no remote
 * attacker" is not "no attacker": a page in any browser tab can issue requests
 * to 127.0.0.1, and this handler reads the filesystem. Resolution is therefore
 * written to be safe on its own terms rather than on the strength of D8.
 */

import { join, normalize, resolve, sep } from "node:path";

/** The one thing this module needs from the runtime. `Bun.file` satisfies it. */
export interface StaticFile {
	exists(): Promise<boolean>;
	/** A `Response` streaming this file, with a content type. */
	toResponse(): Response;
}

export type OpenFile = (absolutePath: string) => StaticFile;

/**
 * Map a URL pathname to an absolute path inside `root`, or null if it does not
 * name one.
 *
 * Three things go wrong here and all three are reachable from a URL bar:
 *
 *  - `..`. `normalize` clamps leading `..` at the root of an absolute path
 *    (verified: `/a/../../../etc/passwd` -> `/etc/passwd`), which is why
 *    prefixing `/` before normalising is load-bearing rather than cosmetic. The
 *    containment check afterwards is belt and braces -- it does not rely on
 *    that property holding on every platform.
 *  - A malformed escape. `decodeURIComponent("/%zz")` throws `URIError`
 *    (verified), and an uncaught throw here is a 500 for what is simply not a
 *    path we have.
 *  - A NUL byte. `%00` survives decoding into the string (verified), and the
 *    fs layer rejects it with a type error rather than "no such file".
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;

	// Force-absolute before normalising: that is what makes `..` clamp instead
	// of escaping upward.
	const rel = normalize(decoded.startsWith("/") ? decoded : `/${decoded}`);
	const candidate = resolve(root, `.${rel}`);
	const base = resolve(root);
	// Unreachable as things stand -- no input gets past the clamp above, which
	// is why no test covers this line, and mutating it away leaves the suite
	// green. It is here because the clamp is a property of `normalize` on an
	// absolute path rather than something this function guarantees itself, and a
	// containment check is the cheap way not to depend on that.
	if (candidate !== base && !candidate.startsWith(base + sep)) return null;
	return candidate;
}

/**
 * The built SPA, with the usual single-page fallback. Absent in dev, where Vite
 * serves the client and proxies `/api` here.
 *
 * The fallback is deliberately limited to navigations (`Accept: text/html`).
 * Handing `index.html` to a `<script src>` that 404'd turns a missing asset into
 * a syntax error in the console, which is a genuinely bad half-hour.
 */
export function createStaticHandler(root: string, open: OpenFile) {
	const indexPath = join(root, "index.html");

	return async function serveStatic(request: Request): Promise<Response | null> {
		if (request.method !== "GET" && request.method !== "HEAD") return null;

		const { pathname } = new URL(request.url);
		const candidate = resolveWithinRoot(root, pathname);
		if (candidate !== null && candidate !== indexPath) {
			const file = open(candidate);
			if (await exists(file)) return file.toResponse();
		}

		const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
		if (!wantsHtml && candidate !== indexPath) return null;

		const index = open(indexPath);
		return (await exists(index)) ? index.toResponse() : null;
	};
}

/** A path that is a directory (or otherwise unopenable) is a miss, not a crash. */
async function exists(file: StaticFile): Promise<boolean> {
	try {
		return await file.exists();
	} catch {
		return false;
	}
}
