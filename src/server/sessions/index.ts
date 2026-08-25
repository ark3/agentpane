/**
 * Session enumeration (DESIGN D9): walk the backends' on-disk stores, with
 * no agent process running, and merge into one recency-sorted list.
 *
 * No cache -- fresh walk + read on every call. DESIGN is explicit that the
 * measured numbers (973 files across 28 workspaces, ~0.3s in Python) do not
 * justify one yet; this module leaves room for one (a cache would slot in
 * here, in front of `findJsonlFiles` + the per-file parsers) without being
 * one.
 */

import type { Stats } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRef, SessionSummary } from "../../shared/protocol.ts";
import { findClaudeSessionFiles, parseClaudeSession } from "./claude.ts";
import { parseCodexSession } from "./codex.ts";
import { parsePiSession } from "./pi.ts";
import { fileMatchesThreadId, findJsonlFiles } from "./walk.ts";

export interface ListSessionsOptions {
	/**
	 * Absolute workspace path to filter by (exact match against the `cwd`
	 * this module recorded for each session). Omit for every session
	 * everywhere. Path normalization, if any is needed, is the caller's job --
	 * this module doesn't know where the filter value came from.
	 */
	cwd?: string;
	/** Override the Codex sessions root. Primarily for hermetic tests. */
	codexRoot?: string;
	/** Override the Pi sessions root. Primarily for hermetic tests. */
	piRoot?: string;
	/** Override the Claude Code projects root. Primarily for hermetic tests. */
	claudeRoot?: string;
	/** Cap on files read concurrently, to bound open file descriptors. */
	concurrency?: number;
}

const DEFAULT_CODEX_ROOT = join(homedir(), ".codex", "sessions");
const DEFAULT_PI_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_CLAUDE_ROOT = join(homedir(), ".claude", "projects");
const DEFAULT_CONCURRENCY = 64;

/** Store roots, shared with the preview path so it locates files the same way. */
export const SESSION_ROOTS = {
	codex: DEFAULT_CODEX_ROOT,
	pi: DEFAULT_PI_ROOT,
	claude: DEFAULT_CLAUDE_ROOT,
} as const;

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			// biome-ignore lint: index is always in range, guarded above
			results[i] = await fn(items[i] as T);
		}
	}

	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

async function loadOne<T>(
	filePath: string,
	parse: (filePath: string, stat: Stats) => Promise<T>,
): Promise<T | null> {
	try {
		const stat = await fsStat(filePath);
		return await parse(filePath, stat);
	} catch {
		// File vanished between walk and stat, or is otherwise unreadable.
		// Enumeration tolerates a single bad file rather than failing the
		// whole listing.
		return null;
	}
}

function isPresent<T>(value: T | null): value is T {
	return value !== null;
}

export async function listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
	const codexRoot = opts.codexRoot ?? DEFAULT_CODEX_ROOT;
	const piRoot = opts.piRoot ?? DEFAULT_PI_ROOT;
	const claudeRoot = opts.claudeRoot ?? DEFAULT_CLAUDE_ROOT;
	const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

	const [codexFiles, piFiles, claudeFiles] = await Promise.all([
		findJsonlFiles(codexRoot),
		findJsonlFiles(piRoot),
		findClaudeSessionFiles(claudeRoot),
	]);

	const [codexSummaries, piSummaries, claudeSummaries] = await Promise.all([
		mapLimit(codexFiles, concurrency, (f) => loadOne(f, parseCodexSession)),
		mapLimit(piFiles, concurrency, (f) => loadOne(f, parsePiSession)),
		mapLimit(claudeFiles, concurrency, (f) => loadOne(f, parseClaudeSession)),
	]);

	let all: SessionSummary[] = [
		...codexSummaries.filter(isPresent),
		...piSummaries.filter(isPresent),
		...claudeSummaries.filter(isPresent),
	];

	if (opts.cwd !== undefined) {
		all = all.filter((s) => s.cwd === opts.cwd);
	}

	// Recency, most recent first. `updatedAt` is the file's mtime (set by
	// every parser), which is always present for a file we could stat -- so
	// this never falls back to a missing-timestamp case in practice.
	all.sort((a, b) => {
		const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
		const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
		return bt - at;
	});

	return all;
}

export interface GetSessionOptions {
	/** Override the Codex sessions root. Primarily for hermetic tests. */
	codexRoot?: string;
	/** Override the Pi sessions root. Primarily for hermetic tests. */
	piRoot?: string;
	/** Override the Claude Code projects root. Primarily for hermetic tests. */
	claudeRoot?: string;
}

/**
 * Metadata for exactly one stored session, located without walking or parsing
 * the rest of the corpus the way `listSessions` must. The
 * backends locate their one file the same way the preview path (OW-38) does:
 *
 *  - **Pi**: the ref IS the file path (D9), so this is a direct stat + parse,
 *    no discovery at all.
 *  - **Codex**: the ref's id is a uuid embedded in the filename. A
 *    readdir-only walk (`findJsonlFiles`) locates the one matching name, and
 *    only that file is stat'd and parsed.
 *  - **Claude Code**: the ref's id is the uuid the file is named after; same
 *    match-by-filename, over the readdir-only `findClaudeSessionFiles` walk.
 *
 * A missing/unreadable file, or no filename match, returns null --
 * the same "unknown ref" result `listSessions().find(...)` gave before.
 */
export async function getSession(
	ref: SessionRef,
	opts: GetSessionOptions = {},
): Promise<SessionSummary | null> {
	if (ref.backend === "pi") {
		return loadOne(ref.id, parsePiSession);
	}

	if (ref.backend === "claude") {
		const files = await findClaudeSessionFiles(opts.claudeRoot ?? DEFAULT_CLAUDE_ROOT);
		const match = files.find((file) => fileMatchesThreadId(file, ref.id));
		if (!match) return null;
		return loadOne(match, parseClaudeSession);
	}

	const root = opts.codexRoot ?? DEFAULT_CODEX_ROOT;
	const files = await findJsonlFiles(root);
	const match = files.find((file) => fileMatchesThreadId(file, ref.id));
	if (!match) return null;
	return loadOne(match, parseCodexSession);
}
