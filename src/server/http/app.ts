/**
 * What the server answers over HTTP: the static bundle, and the upgrade to
 * the socket that carries everything else (D31). `src/shared/protocol.ts`
 * is the contract; the socket's half of it is `connect`, which is
 * `openConnection` in `socket.ts`.
 *
 * `createApp` has no runtime coupling: `fetch` is a plain
 * `(Request) => Response`, and `connect` takes a `send` and an `end`, so the
 * whole server is exercisable in-process by tests that never open a socket.
 * `src/server/index.ts` is the thin Bun binding.
 */

import { type ApiError, SOCKET_PATH } from "../../shared/protocol.ts";
import { Broadcaster } from "./broadcaster.ts";
import type { AppDeps } from "./deps.ts";
import { SessionManager } from "./session-manager.ts";
import { type Connection, openConnection } from "./socket.ts";

export interface App {
	/** The static bundle, behind the `Host` check; anything under `/api` but the upgrade is not found. */
	fetch(request: Request): Promise<Response>;
	/** Whether a request is for the socket's path, which the binding upgrades rather than fetches. */
	isSocketRequest(request: Request): boolean;
	/**
	 * The refusal of a socket's upgrade, or null to let it proceed. The `Host`
	 * and `Origin` checks run here; the token does not, since a browser cannot
	 * set a header on a socket, and arrives in the first frame instead (D31
	 * point 5).
	 */
	admitUpgrade(request: Request): Response | null;
	/** One socket, from its upgrade to its close: see `src/server/http/socket.ts`. */
	connect(send: (frame: string) => void, end: (code: number, reason: string) => void): Connection;
	readonly sessions: SessionManager;
	readonly broadcaster: Broadcaster;
	/** End every socket and dispose every adapter. Server shutdown only. */
	close(): Promise<void>;
}

export function createApp(deps: AppDeps): App {
	const broadcaster = new Broadcaster();
	const sessions = new SessionManager(deps, broadcaster);
	const logError = deps.logError ?? ((message: string) => console.error(message));
	const apiToken = Buffer.from(deps.apiToken, "utf8");

	return {
		async fetch(request) {
			// Before anything parses `request.url`, which Bun leaves relative for an
			// HTTP/1.0 request that names no host.
			if (!isLoopbackHost(request)) {
				return error(403, "forbidden_host", "this server answers only to a loopback name");
			}
			const { pathname } = new URL(request.url);
			// Not the bundle's single-page fallback: a client still asking for a
			// route that is gone is told so, not handed `index.html`.
			if (pathname === "/api" || pathname.startsWith("/api/")) return notFound(pathname);
			return (await deps.staticHandler?.(request)) ?? notFound(pathname);
		},
		isSocketRequest(request) {
			try {
				return new URL(request.url).pathname === SOCKET_PATH;
			} catch {
				// A relative URL, from an HTTP/1.0 request that names no host:
				// `fetch` refuses it for that.
				return false;
			}
		},
		admitUpgrade(request) {
			if (!isLoopbackHost(request)) {
				return error(403, "forbidden_host", "this server answers only to a loopback name");
			}
			// A browser applies no same-origin policy to a socket, so this is the
			// only check there is against a page elsewhere driving it.
			if (!isTrustedRequestMetadata(request.headers)) {
				return error(403, "forbidden_origin", "this API is reachable only from a local page");
			}
			if (request.method !== "GET") return methodNotAllowed(request.method, "GET");
			return null;
		},
		connect(send, end) {
			return openConnection({ deps, sessions, broadcaster, apiToken, logError }, send, end);
		},
		sessions,
		broadcaster,
		async close() {
			broadcaster.closeAll();
			await sessions.disposeAll();
		},
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * D8 binds 127.0.0.1 so nothing off this machine can reach us. That closes the
 * network, not the browser: any page in any tab can open a WebSocket to a
 * loopback port, and a browser applies no same-origin policy to one, so the
 * page could drive every command on it and read every reply. The commands
 * spawn sandboxed agents with write access to the user's repositories.
 *
 * This stops a browser, not a local process, which can send any header; the
 * token in the socket's first frame is what stops that (D29, which overturned
 * D8's "no auth needs to exist once remote access is off the table", and D31
 * point 5). pipane has no origin check either (HANDOFF finding 17), which is
 * where the gap was inherited from.
 *
 * The Origin rule is loopback-*origin*, not same-origin: in dev the page is
 * served by Vite on another port and proxied here, so an exact match would
 * reject the only client we have. Browsers can omit Origin on some cross-site
 * requests, so Sec-Fetch-Site closes that gap: when present it must say
 * `same-origin` or `none`. Header absence passes this check for non-browser
 * clients such as the probes and the Emacs helper, which still need the token
 * and a loopback `Host` (D29), while the production and proxied development
 * clients are same-origin and send `same-origin`.
 */
function isTrustedRequestMetadata(headers: Headers): boolean {
	const site = headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	return isLoopbackOrigin(headers.get("origin"));
}

function isLoopbackOrigin(origin: string | null): boolean {
	if (origin === null) return true;
	let hostname: string;
	try {
		({ hostname } = new URL(origin));
	} catch {
		// Includes the literal `"null"` an opaque origin sends -- a sandboxed
		// iframe or a `data:` document. Not a URL, and never ours.
		return false;
	}
	return isLoopbackHostname(hostname);
}

/**
 * DNS rebinding gets past the Origin check above: a page whose own name has
 * been pointed at 127.0.0.1 is same-origin with us as far as the browser can
 * tell, so it sends `Sec-Fetch-Site: same-origin` and an Origin naming itself
 * only on the requests that carry one. What it cannot hide is that name, in the
 * `Host` header, so every request -- the static bundle included -- must name
 * loopback there. Any port: an `ssh -L` forward may pick its own local port,
 * and the Vite dev proxy forwards with `changeOrigin: false`, so we see its.
 *
 * The header is read directly rather than through `request.url`. As of
 * `bun 1.4.0` `Bun.serve` builds the URL from it anyway, but a `Request` built
 * in-process keeps its own URL beside whatever header it was given. With no
 * header the URL is all there is: in-process it is the test's own, and from
 * Bun it is relative -- an HTTP/1.0 request that names no host -- which does
 * not parse and is refused. (HTTP/1.1 without one Bun answers 400 itself.)
 *
 * This stops a browser, not a local process, which can send any header.
 */
function isLoopbackHost(request: Request): boolean {
	const host = request.headers.get("host");
	if (host === null) {
		try {
			return isLoopbackHostname(new URL(request.url).hostname);
		} catch {
			return false;
		}
	}
	// `uri-host [ ":" port ]` taken apart by hand: `new URL` would read
	// `evil.example@127.0.0.1` as userinfo and hand back a loopback hostname.
	const match = /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/.exec(host);
	return match !== null && isLoopbackHostname((match[1] as string).toLowerCase());
}

function isLoopbackHostname(hostname: string): boolean {
	// Anchored, because `127.0.0.0/8` is all loopback but `startsWith("127.")`
	// also accepts `127.0.0.1.evil.example`, which is a name someone else owns.
	// Caught by the tests in `app.test.ts`, not by reading this back.
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(hostname)
	);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function error(status: number, code: string, detail: string): Response {
	const body: ApiError = { error: code, detail };
	return json(body, status);
}

function notFound(path: string): Response {
	return error(404, "not_found", `no route for ${path}`);
}

function methodNotAllowed(method: string, allow: string): Response {
	const response = error(405, "method_not_allowed", `${method} not allowed; try ${allow}`);
	response.headers.set("allow", allow);
	return response;
}
