/**
 * The Emacs helper's API token: read from the file the server keeps it in
 * (`apiTokenPath` in `src/server/api-token.ts`) and sent as the bearer of
 * every request, the event stream's included. The server exempts that route,
 * so the header is harmless there, and one wrapper under both the api client
 * and `sseOpenEvents` leaves no request to forget it (`main.ts`).
 *
 * The helper needs no paste, as the browser does: Emacs starts it outside any
 * sandbox, so it can read `~/.ssh`, which `sbox` hides from agents. It never
 * creates the file; only the server does.
 *
 * Read on every request, not at startup, so the token sent is always the
 * file's current one and the request knows whether it sent one. A rotation
 * (deleting the file and restarting the server) already ends this helper,
 * since the stream drops with the server (`runHelper`), but a startup read
 * would also go stale against a server first started after the helper.
 *
 * A missing or unreadable file is not an error here: the request goes out
 * without the header. A server that is not running then still shows as the
 * stream failing to open, answered as unreachable, and a missing file usually
 * means no server has run on this machine. Only the server's 401 becomes the
 * error naming the file, thrown as the `ApiClientError` the api client would
 * have thrown for it, so `toRpcError` in `helper.ts` keeps its `data.status`
 * and agentpane-mode reads it as the server refusing the request.
 */

import { readFileSync } from "node:fs";
import { ApiClientError } from "$client/api.ts";
import { apiTokenPath } from "$server/api-token.ts";

/** Wraps `fetchImpl` to send the token; `home` is injectable for tests, and defaults to the user's. */
export function withApiToken(fetchImpl: typeof fetch, home?: string): typeof fetch {
	// Only ever called, never asked for Bun's `preconnect`, so the cast is safe.
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = apiTokenPath(home);
		const token = readToken(path);
		const headers = { ...(init?.headers as Record<string, string> | undefined) };
		if (typeof token === "string") headers["authorization"] = `Bearer ${token}`;
		const response = await fetchImpl(input, { ...init, headers });
		if (response.status !== 401) return response;
		void response.body?.cancel();
		const why =
			typeof token === "string"
				? `the server refused the API token in ${path}`
				: `no API token was sent because ${path} ${token.reason}`;
		throw new ApiClientError(401, "unauthorized", why);
	}) as typeof fetch;
}

/** The token, or why none was read. Trailing whitespace is trimmed, as the server trims it. */
function readToken(path: string): string | { reason: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8").trimEnd();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return { reason: code === "ENOENT" ? "does not exist" : `could not be read (${code ?? String(err)})` };
	}
	return text === "" ? { reason: "holds no token" } : text;
}
