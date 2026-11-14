/**
 * The API token's file: where it lives, and the rule for reading it at startup.
 *
 * The file is `~/.ssh/agentpane-token` because `~/.ssh` is the one directory
 * `sbox` hides from the agents it jails: on the home server it is a tmpfs, and
 * on the work laptop seatbelt denies reads under it. So an agent, which is
 * exactly the local process the token keeps out, cannot read it, and the
 * server, which runs outside any sandbox, reads the real file. A server
 * started inside `sbox` sees its own tmpfs `~/.ssh` and creates a throwaway
 * token there.
 *
 * The token goes back to the caller and nowhere else. It must never be put in
 * `process.env` or in a child's environment: every agent is a child of the
 * server, so an environment variable would hand it to them.
 *
 * Rotation is deleting the file and restarting.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, linkSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The token file's path. Resolved through `os.homedir()` on every call, not
 * at module load, so a test that replaces `os.homedir()` after import moves
 * it, as `src/server/api-token.test.ts` does by mocking `node:os`. Stubbing
 * `HOME` does not: the suite runs under `vmThreads`, where a worker's
 * `process.env` is its own copy and never reaches the `getenv` that
 * `os.homedir()` reads. `home` is for a caller that injects its own, as the
 * Emacs helper's tests do (`src/emacs/token.ts`).
 */
export function apiTokenPath(home: string = homedir()): string {
	return join(home, ".ssh", "agentpane-token");
}

/** Startup must not proceed; the message says what to fix. */
export class ApiTokenError extends Error {}

/**
 * Reads the token, creating its file when absent. Throws `ApiTokenError` when
 * the server must refuse to start.
 *
 * - No `~/.ssh`: refused. The directory is not created; its mode and contents
 *   are the owner's to decide, as they are for ssh.
 * - No file: created holding 32 random bytes in base64url, then read back like
 *   any existing file. The token is written to a temporary file beside it,
 *   created exclusively at `0600`, which is then hard-linked to the token
 *   file's path; the link is atomic and fails when the path exists, so the
 *   file never appears there short of its whole token. Losing a race to
 *   another server creating it at the same moment fails the link, and the
 *   winner's file is read. The temporary file is removed whatever happened.
 * - An existing file is refused when it is not owned by the running user or
 *   grants any group or other permission, as ssh refuses such a key, and when
 *   it holds nothing but whitespace. Trailing whitespace is trimmed, so a
 *   hand-written file with a final newline works.
 */
export function loadApiToken(): string {
	const path = apiTokenPath();
	const dir = join(homedir(), ".ssh");
	if (!isDirectory(dir)) {
		throw new ApiTokenError(
			`agentpane: ${dir} does not exist, and agentpane keeps its API token in ${path}. ` +
				`Create the directory (mkdir -m 700 ${dir}) and start again; agentpane does not create it.`,
		);
	}
	const temp = join(dir, `.agentpane-token.${process.pid}.${randomBytes(8).toString("hex")}`);
	try {
		writeFileSync(temp, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
		try {
			linkSync(temp, path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	} finally {
		rmSync(temp, { force: true });
	}
	return readTokenFile(path);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/** Checks and reads through one descriptor, so the file checked is the file read. */
function readTokenFile(path: string): string {
	const fd = openSync(path, "r");
	try {
		const stat = fstatSync(fd);
		const uid = process.getuid?.();
		if (uid !== undefined && stat.uid !== uid) {
			throw new ApiTokenError(
				`agentpane: ${path} is owned by uid ${stat.uid}, not by the running user (uid ${uid}). ` +
					`Delete it and start again to create a new token, or chown it to the running user.`,
			);
		}
		if ((stat.mode & 0o077) !== 0) {
			const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
			throw new ApiTokenError(
				`agentpane: permissions ${mode} for ${path} are too open; it must be readable by its owner only. ` +
					`Run: chmod 600 ${path}`,
			);
		}
		const token = readFileSync(fd, "utf8").trimEnd();
		if (token === "") {
			throw new ApiTokenError(
				`agentpane: ${path} holds no token. Delete it and start again to create a new one.`,
			);
		}
		return token;
	} finally {
		closeSync(fd);
	}
}
