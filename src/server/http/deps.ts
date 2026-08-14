/**
 * The seams the HTTP layer is built against.
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
	 * its flattened text turns, spawning nothing. Like the rest of this seam it
	 * touches exactly the one session's file, never the whole corpus.
	 */
	preview(ref: SessionRef): Promise<SessionPreviewTurn[]>;
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
		return [];
	},
};

export interface AppDeps {
	index: SessionIndex;
	/**
	 * One factory per backend. Partial because a deployment may be missing one
	 * (or a test may only care about one); requests for an absent backend get a
	 * clean 501 rather than a crash.
	 */
	adapters: Partial<Record<BackendId, AdapterFactory>>;
	/**
	 * SSE keepalive comment interval. 0 disables it, which is what tests want --
	 * a live interval keeps the process (and vitest) alive.
	 */
	heartbeatMs?: number;
	/** Id generator for `virtual` sessions. Injectable so tests are deterministic. */
	newId?: () => string;
	/** ISO clock, injectable for the same reason. */
	now?: () => string;
	/**
	 * Anything not under `/api`. The SPA bundle, in practice. Returning null
	 * falls through to a 404. Kept out of here so the API is testable without a
	 * filesystem or a Bun global.
	 */
	staticHandler?: (request: Request) => Promise<Response | null> | Response | null;
}
