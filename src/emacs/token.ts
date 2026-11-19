/**
 * The Emacs helper's API token: read from the file the server keeps it in
 * (`apiTokenPath` in `src/server/api-token.ts`) and carried by the `hello`,
 * the socket's first frame (D31 point 5).
 *
 * The helper needs no paste, as the browser does: Emacs starts it outside any
 * sandbox, so it can read `~/.ssh`, which `sbox` hides from agents. It never
 * creates the file; only the server does.
 *
 * Read at the connect, which the helper makes once, at its start: a rotation
 * (deleting the file and restarting the server) closes the socket and ends
 * the helper (`runHelper`), and the next one reads the new token.
 *
 * A missing or unreadable file is not an error here: the `hello` carries no
 * token, which the server refuses. Only that refusal becomes the error naming
 * the file, as the `refusal` below, which `runHelper` puts in place of the api
 * client's own detail for each request the refusal ends.
 */

import { readFileSync } from "node:fs";
import { apiTokenPath } from "$server/api-token.ts";

export interface ApiToken {
	/** The token, or null where none was read. */
	value: string | null;
	/** What to tell the owner should the server refuse the `hello` this read went out on. */
	refusal: string;
}

/** `home` is injectable for tests, and defaults to the user's. */
export function readApiToken(home?: string): ApiToken {
	const path = apiTokenPath(home);
	const token = readToken(path);
	return typeof token === "string"
		? { value: token, refusal: `the server refused the API token in ${path}` }
		: { value: null, refusal: `no API token was sent because ${path} ${token.reason}` };
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
