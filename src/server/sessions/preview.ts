/**
 * Read-only transcript preview for a single stored session (OW-38).
 *
 * This is the non-attaching counterpart to `SessionManager.attach`: selecting a
 * session to *look at* must be as cheap as listing one (D9), so this spawns no
 * subprocess and -- crucially -- reads exactly one session file, never the
 * whole corpus: Pi's by its path, the ref (D9), and Codex's and Claude Code's
 * by a readdir-only match on the id in its filename. The one exception is a
 * Codex fork whose rollout holds none of its inherited history: it also reads
 * the rollouts that history lives in, one per fork in its ancestry, located
 * by name like its own (OW-buligi). It never calls `listSessions()` or
 * `index.list()`, which parse every file in every store.
 *
 * A ref no file backs -- a Pi path that does not resolve inside the store,
 * or no filename match -- answers null rather than throwing, and never an
 * empty preview, which is a file with no turns: `sessions/preview` reads the
 * null, for a ref the manager does not hold, as the session gone (D26
 * point 5).
 */

import type { SessionPreviewTurn, SessionRef } from "../../shared/protocol.ts";
import { extractClaudePreviewTurns, findClaudeSessionFiles } from "./claude.ts";
import { type CodexRolloutLocator, extractCodexPreviewTurns } from "./codex.ts";
import { codexSessionsRoot, resolvePiSessionPath, SESSION_ROOTS } from "./index.ts";
import { extractPiPreviewTurns } from "./pi.ts";
import { fileMatchesThreadId, findJsonlFiles } from "./walk.ts";

export interface ReadPreviewOptions {
	/** Override the Codex sessions root. Primarily for hermetic tests. */
	codexRoot?: string;
	/** Override the Pi sessions root. Primarily for hermetic tests. */
	piRoot?: string;
	/** Override the Claude Code projects root. Primarily for hermetic tests. */
	claudeRoot?: string;
	/**
	 * readdir-only discovery seam. Defaults to the real walk (`findJsonlFiles`
	 * for Codex, `findClaudeSessionFiles` for Claude Code); a test injects a
	 * counter to prove no file beyond the match is opened.
	 */
	findFiles?: (root: string) => Promise<string[]>;
	/** Pi transcript extractor seam. Defaults to the real one. */
	readPiTurns?: (filePath: string) => Promise<SessionPreviewTurn[]>;
	/** Codex transcript extractor seam. Defaults to the real one. */
	readCodexTurns?: (filePath: string, locate: CodexRolloutLocator) => Promise<SessionPreviewTurn[]>;
	/** Claude Code transcript extractor seam. Defaults to the real one. */
	readClaudeTurns?: (filePath: string) => Promise<SessionPreviewTurn[]>;
}

export async function readSessionPreview(
	ref: SessionRef,
	opts: ReadPreviewOptions = {},
): Promise<SessionPreviewTurn[] | null> {
	const readPiTurns = opts.readPiTurns ?? extractPiPreviewTurns;
	const readCodexTurns = opts.readCodexTurns ?? extractCodexPreviewTurns;
	const readClaudeTurns = opts.readClaudeTurns ?? extractClaudePreviewTurns;

	if (ref.backend === "pi") {
		// D9: the ref IS the file path. Validate it against the same store-root
		// boundary as attach, then read it directly with no discovery.
		const file = await resolvePiSessionPath(ref.id, opts.piRoot);
		return file === null ? null : readPiTurns(file);
	}

	if (ref.backend === "claude") {
		// Find the one filename carrying this session uuid, then read only it.
		const findFiles = opts.findFiles ?? findClaudeSessionFiles;
		const files = await findFiles(opts.claudeRoot ?? SESSION_ROOTS.claude);
		const match = files.find((file) => fileMatchesThreadId(file, ref.id));
		if (!match) return null;
		return readClaudeTurns(match);
	}

	// Codex: find the one filename carrying this thread id, then read only it.
	const findFiles = opts.findFiles ?? findJsonlFiles;
	const root = opts.codexRoot ?? codexSessionsRoot();
	const files = await findFiles(root);
	const match = files.find((file) => fileMatchesThreadId(file, ref.id));
	if (!match) return null;
	return readCodexTurns(match, (threadId) => files.find((file) => fileMatchesThreadId(file, threadId)));
}
