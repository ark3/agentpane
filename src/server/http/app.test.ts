/**
 * What the server answers over HTTP: the static bundle and the socket's
 * upgrade, and nothing else (D31). Everything the socket carries is
 * `socket.test.ts`'s.
 *
 * Each test goes through `app.fetch` or `app.admitUpgrade` with a plain
 * `Request`, which is what `src/server/index.ts` hands them.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type ApiError, SOCKET_PATH, type SessionRef } from "../../shared/protocol.ts";
import { type App, createApp } from "./app.ts";
import { FakeAdapterFactory, FakeSessionIndex, storedSession } from "./testing/fakes.ts";
import { TEST_API_TOKEN } from "./testing/app.ts";

const PI_SESSION: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/one.jsonl" };

let pi: FakeAdapterFactory;
let app: App;

function build(staticHandler?: () => Response): void {
	pi = new FakeAdapterFactory();
	app = createApp({
		index: new FakeSessionIndex([storedSession(PI_SESSION, process.cwd())]),
		adapters: { pi },
		apiToken: TEST_API_TOKEN,
		...(staticHandler ? { staticHandler } : {}),
	});
}

beforeEach(() => build(() => new Response("<!doctype html>", { status: 200 })));

function get(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
	return app.fetch(new Request(`http://127.0.0.1${path}`, { method, headers }));
}

function upgrade(headers: Record<string, string> = {}, method = "GET"): Request {
	return new Request(`http://127.0.0.1:4173${SOCKET_PATH}`, { method, headers: { host: "127.0.0.1:4173", ...headers } });
}

async function codeOf(response: Response | null | undefined): Promise<[number | undefined, string | undefined]> {
	return [response?.status, ((await response?.json()) as ApiError | undefined)?.error];
}

describe("the static bundle", () => {
	it("is what answers outside /api", async () => {
		expect((await get("/")).status).toBe(200);
	});

	it("is not found with no static handler", async () => {
		build();
		expect(await codeOf(await get("/index.html"))).toEqual([404, "not_found"]);
	});

	it("is left alone by the Origin check, which guards the socket", async () => {
		expect((await get("/", { origin: "https://evil.example" })).status).toBe(200);
	});
});

describe("under /api", () => {
	it("answers not found for every path but the upgrade, a retired route included, and never the bundle", async () => {
		const retired = [
			["GET", "/api/events"],
			["GET", "/api/sessions"],
			["POST", "/api/sessions"],
			["GET", `/api/sessions/pi/${encodeURIComponent(PI_SESSION.id)}`],
			["POST", `/api/sessions/pi/${encodeURIComponent(PI_SESSION.id)}/prompt`],
			["GET", "/api/models"],
			["POST", "/api/edit-draft"],
			["GET", "/api"],
			["GET", "/api/nope"],
		];
		for (const [method, path] of retired) {
			const response = await get(path as string, { authorization: `Bearer ${TEST_API_TOKEN}` }, method);
			expect([method, path, ...(await codeOf(response))]).toEqual([method, path, 404, "not_found"]);
		}
		expect(pi.created).toHaveLength(0);
	});
});

describe("the upgrade", () => {
	it("is the socket's path and nothing else", () => {
		expect(app.isSocketRequest(upgrade())).toBe(true);
		expect(app.isSocketRequest(new Request("http://127.0.0.1:4173/api/events"))).toBe(false);
		expect(app.isSocketRequest(new Request(`http://127.0.0.1:4173${SOCKET_PATH}/x`))).toBe(false);
	});

	it("is admitted with no token, which the first frame carries", () => {
		expect(app.admitUpgrade(upgrade())).toBeNull();
	});

	it("is refused for a method that is not GET", async () => {
		const refusal = app.admitUpgrade(upgrade({}, "POST"));
		expect(await codeOf(refusal)).toEqual([405, "method_not_allowed"]);
		expect(refusal?.headers.get("allow")).toBe("GET");
	});
});

describe("origin", () => {
	// D8 binds loopback, which closes the network but not the browser: any page
	// in any tab can open a WebSocket to 127.0.0.1, and a browser applies no
	// same-origin policy to one.
	it("refuses an upgrade a page on the web asked for on the user's behalf", async () => {
		for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
			expect([origin, ...(await codeOf(app.admitUpgrade(upgrade({ origin }))))]).toEqual([origin, 403, "forbidden_origin"]);
		}
	});

	it("refuses cross-site metadata even when the browser omits Origin, and same-site, since the client itself is same-origin", async () => {
		for (const site of ["cross-site", "same-site"]) {
			expect([site, ...(await codeOf(app.admitUpgrade(upgrade({ "sec-fetch-site": site }))))]).toEqual([site, 403, "forbidden_origin"]);
		}
	});

	it("admits same-origin and navigation metadata, and requests with neither header for non-browser clients", () => {
		expect(app.admitUpgrade(upgrade({ "sec-fetch-site": "same-origin" }))).toBeNull();
		expect(app.admitUpgrade(upgrade({ "sec-fetch-site": "none" }))).toBeNull();
		expect(app.admitUpgrade(upgrade())).toBeNull();
	});

	it("admits the dev server's origin, which is loopback on another port", () => {
		// vite.config.ts serves the client from 127.0.0.1:5173 and proxies /api
		// here with changeOrigin: false, so same-origin would reject dev.
		for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173"]) {
			expect(app.admitUpgrade(upgrade({ origin, "sec-fetch-site": "same-origin" }))).toBeNull();
		}
	});
});

describe("host", () => {
	// A page that rebinds its own name to 127.0.0.1 reaches us as same-origin,
	// so Origin and Sec-Fetch-Site both pass; only the Host it names is not ours.
	// `request.url` stays 127.0.0.1 here, as a real one would not, so these
	// tests can only pass on a check that reads the header.
	it("refuses a rebound name on the upgrade, the static bundle and under /api", async () => {
		const host = "evil.example:4173";
		expect(await codeOf(app.admitUpgrade(upgrade({ host, "sec-fetch-site": "same-origin" })))).toEqual([403, "forbidden_host"]);
		expect(await codeOf(await get("/", { host }))).toEqual([403, "forbidden_host"]);
		expect(await codeOf(await get("/api/nope", { host }))).toEqual([403, "forbidden_host"]);
	});

	it("refuses a name that only starts like loopback", async () => {
		for (const host of ["127.0.0.1.evil.example", "127.0.0.1.evil.example:4173"]) {
			expect([host, ...(await codeOf(app.admitUpgrade(upgrade({ host }))))]).toEqual([host, 403, "forbidden_host"]);
		}
	});

	it("admits every loopback name on any port, since a forward or the dev proxy picks it", async () => {
		for (const host of ["localhost:8022", "127.0.0.1:5173", "127.1.2.3:9999", "[::1]:41730"]) {
			expect([host, app.admitUpgrade(upgrade({ host }))]).toEqual([host, null]);
			expect([host, (await get("/", { host })).status]).toEqual([host, 200]);
		}
	});
});
