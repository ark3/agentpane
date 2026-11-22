/**
 * The seams the server's transport is built against.
 *
 * The transport owns no backends and no session store. Everything it needs
 * from the rest of the server arrives through this module, which is what lets
 * it be tested end to end against fakes with no subprocess and no filesystem
 * (see `testing/fakes.ts`).
 */

import type {
	BackendId,
	ListSessionsQuery,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "../../shared/protocol.ts";
import type { AdapterFactory } from "../adapters/types.ts";

/**
 * Read-only view of the sessions that exist in the backends' on-disk stores
 * (DESIGN D9). Implemented by the session-index workstream (`src/server/sessions/`);
 * the transport only ever consumes this shape, so the two can be written apart.
 *
 * Enumeration never spawns anything -- a summary is metadata read from the head
 * of a JSONL file. `status`/`isStreaming` on the returned summaries are ignored
 * by the transport: it owns the process table and overlays the live values
 * itself.
 */
export interface SessionIndex {
	list(query?: ListSessionsQuery): Promise<SessionSummary[]>;
	/**
	 * Metadata for one session, or null if the store has no such session. The
	 * transport needs this on attach for exactly one reason: `cwd`, which is the
	 * workspace the subprocess must be spawned in (D7 -- get it wrong and sbox
	 * jails the wrong tree).
	 */
	get(ref: SessionRef): Promise<SessionSummary | null>;
	/**
	 * A read-only, non-attaching transcript preview for one stored session
	 * (OW-38). Distinct from `get`: it reads the session's own JSONL and returns
	 * its transcript messages, spawning nothing. Like the rest of this seam it
	 * touches exactly the one session's file, never the whole corpus. Null when
	 * no file backs the ref, which is not the same answer as a file with no
	 * turns: `sessions/preview` reads it, for a ref the manager does not hold,
	 * as the session gone (D26 point 5).
	 */
	preview(ref: SessionRef): Promise<SessionPreviewTurn[] | null>;
}

/** An index with nothing in it. Useful before the real one exists. */
export const emptySessionIndex: SessionIndex = {
	async list() {
		return [];
	},
	async get() {
		return null;
	},
	async preview() {
		return null;
	},
};

export interface AppDeps {
	index: SessionIndex;
	/**
	 * The secret a socket's first frame, its `hello`, must carry (D29, D31
	 * point 5). Required, so a composition that forgets
	 * it does not typecheck: the loopback bind and the Host and Origin checks
	 * stop a browser, and only this stops a local process, which can forge every
	 * header but cannot read the token.
	 */
	apiToken: string;
	/**
	 * One factory per backend. Partial because a deployment may be missing one
	 * (or a test may only care about one); a command for an absent backend is
	 * refused `no_backend` rather than crashing.
	 */
	adapters: Partial<Record<BackendId, AdapterFactory>>;
	/** Id generator for `virtual` sessions. Injectable so tests are deterministic. */
	newId?: () => string;
	/** ISO clock, injectable for the same reason. */
	now?: () => string;
	/**
	 * A one-shot timer, answering its cancel: D12's idle clock and D35's
	 * deadline on a start run on it, so a test fires either without waiting
	 * for it. `setTimeout` in production.
	 */
	setTimer?: (run: () => void, ms: number) => () => void;
	/** Unexpected command failures. Defaults to stderr in production. */
	logError?: (message: string) => void;
	/**
	 * Anything not under `/api`. The SPA bundle, in practice. Returning null
	 * falls through to a 404. Kept out of here so the server is testable
	 * without a filesystem or a Bun global.
	 */
	staticHandler?: (request: Request) => Promise<Response | null> | Response | null;
}
