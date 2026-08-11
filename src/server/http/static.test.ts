/**
 * Path resolution for the SPA bundle. The interesting cases are all ones a URL
 * bar can produce, so they are asserted on the resolved path rather than on
 * whether a file happened to be there.
 */

import { describe, expect, it } from "vitest";
import { createStaticHandler, type StaticFile, resolveWithinRoot } from "./static.ts";

const ROOT = "/srv/agentpane/dist/client";

describe("resolveWithinRoot", () => {
	it("resolves an ordinary asset under the root", () => {
		expect(resolveWithinRoot(ROOT, "/assets/app.js")).toBe(`${ROOT}/assets/app.js`);
		expect(resolveWithinRoot(ROOT, "/")).toBe(ROOT);
	});

	it("percent-decodes, because a filename may contain a space", () => {
		expect(resolveWithinRoot(ROOT, "/a%20b.png")).toBe(`${ROOT}/a b.png`);
	});

	it("clamps traversal rather than escaping the bundle", () => {
		for (const attempt of [
			"/../../etc/passwd",
			"/assets/../../../../etc/passwd",
			"/%2e%2e/%2e%2e/etc/passwd",
			"/.%2e/.%2e/etc/passwd",
			"//etc/passwd",
			"/./../etc/passwd",
		]) {
			const resolved = resolveWithinRoot(ROOT, attempt);
			expect(resolved, attempt).not.toBeNull();
			expect(resolved, attempt).toBe(`${ROOT}/etc/passwd`);
		}
	});

	it("refuses a malformed escape instead of throwing", () => {
		// decodeURIComponent throws URIError on this; uncaught it is a 500 for
		// what is simply not a path we have.
		expect(resolveWithinRoot(ROOT, "/%zz")).toBeNull();
		expect(resolveWithinRoot(ROOT, "/%")).toBeNull();
	});

	it("refuses a NUL byte, which survives decoding and trips the fs layer", () => {
		expect(resolveWithinRoot(ROOT, "/a%00b")).toBeNull();
	});
});

// -- handler -----------------------------------------------------------------

function fakeFs(present: Record<string, string>) {
	const opened: string[] = [];
	const open = (path: string): StaticFile => {
		opened.push(path);
		return {
			async exists() {
				if (path.endsWith("/boom")) throw new Error("EISDIR");
				return path in present;
			},
			toResponse: () => new Response(present[path] ?? "", { status: 200 }),
		};
	};
	return { open, opened };
}

const INDEX = `${ROOT}/index.html`;
const navigation = { headers: { accept: "text/html,application/xhtml+xml" } };

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://127.0.0.1${path}`, init);
}

describe("createStaticHandler", () => {
	it("serves a file that is there", async () => {
		const fs = fakeFs({ [`${ROOT}/assets/app.js`]: "console.log(1)" });
		const response = await createStaticHandler(ROOT, fs.open)(req("/assets/app.js"));
		expect(await response?.text()).toBe("console.log(1)");
	});

	it("falls back to index.html for a navigation, so client routes deep-link", async () => {
		const fs = fakeFs({ [INDEX]: "<!doctype html>" });
		const response = await createStaticHandler(ROOT, fs.open)(req("/sessions/abc", navigation));
		expect(await response?.text()).toBe("<!doctype html>");
	});

	it("does NOT hand index.html to a missing asset", async () => {
		// A `<script src>` that resolves to HTML fails as a syntax error in the
		// console with nothing pointing at the real cause.
		const fs = fakeFs({ [INDEX]: "<!doctype html>" });
		expect(await createStaticHandler(ROOT, fs.open)(req("/assets/gone.js"))).toBeNull();
	});

	it("declines anything that is not a read, leaving /api routing alone", async () => {
		const fs = fakeFs({ [INDEX]: "<!doctype html>" });
		const handler = createStaticHandler(ROOT, fs.open);
		expect(await handler(req("/", { method: "POST", ...navigation }))).toBeNull();
	});

	it("declines when there is no bundle at all (dev, where Vite serves it)", async () => {
		const fs = fakeFs({});
		expect(await createStaticHandler(ROOT, fs.open)(req("/", navigation))).toBeNull();
	});

	it("never opens a path outside the bundle", async () => {
		const fs = fakeFs({ [INDEX]: "<!doctype html>" });
		await createStaticHandler(ROOT, fs.open)(req("/../../etc/passwd", navigation));
		expect(fs.opened.every((p) => p.startsWith(`${ROOT}/`) || p === ROOT)).toBe(true);
	});

	it("treats an unopenable path as a miss rather than a 500", async () => {
		const fs = fakeFs({ [INDEX]: "<!doctype html>" });
		const response = await createStaticHandler(ROOT, fs.open)(req("/boom", navigation));
		expect(await response?.text()).toBe("<!doctype html>");
	});
});
