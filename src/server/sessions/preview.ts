/**
 * Read-only transcript preview for a single stored session (OW-38).
 *
 * This is the non-attaching counterpart to `SessionManager.attach`: selecting a
 * session to *look at* must be as cheap as listing one (D9), so this spawns no
 * subprocess and -- crucially -- reads exactly one session file, never the
 * whole corpus. It never calls `listSessions()`, `index.list()`, or
 * `index.get()`, all of which parse every file in both stores.
 *
 * The two backends locate their one file differently:
 *
 *  - **Pi**: the ref IS the JSONL path (D9), so the file is read directly with
 *    no discovery at all.
 *  - **Codex**: the ref is a UUIDv7 thread id embedded in the filename. A
 *    readdir-only walk (`findJsonlFiles`, no file reads) turns up the candidate
 *    names; the one whose filename carries the matching uuid is read, and only
 *    that one. If none matches, the preview is empty rather than an error --
 *    the same "tolerate a missing file" spirit enumeration takes.
 *
 * The flattening is deliberately narrow (see `SessionPreviewResponse`): only
 * user and assistant text turns survive.
 */

import type { SessionPreviewTurn, SessionRef } from "../../shared/protocol.ts";
import { extractCodexPreviewTurns } from "./codex.ts";
import { SESSION_ROOTS } from "./index.ts";
import { extractPiPreviewTurns } from "./pi.ts";
import { fileMatchesThreadId, findJsonlFiles } from "./walk.ts";

export interface ReadPreviewOptions {
	/** Override the Codex sessions root. Primarily for hermetic tests. */
	codexRoot?: string;
	/** Override the Pi sessions root. Primarily for hermetic tests. */
	piRoot?: string;
	/**
	 * readdir-only discovery seam. Defaults to the real walk; a test injects a
	 * counter to prove no file beyond the match is opened.
	 */
	findFiles?: (root: string) => Promise<string[]>;
	/** Pi text-turn extractor seam. Defaults to the real one. */
	readPiTurns?: (filePath: string) => Promise<SessionPreviewTurn[]>;
	/** Codex text-turn extractor seam. Defaults to the real one. */
	readCodexTurns?: (filePath: string) => Promise<SessionPreviewTurn[]>;
}

export async function readSessionPreview(
	ref: SessionRef,
	opts: ReadPreviewOptions = {},
): Promise<SessionPreviewTurn[]> {
	const findFiles = opts.findFiles ?? findJsonlFiles;
	const readPiTurns = opts.readPiTurns ?? extractPiPreviewTurns;
	const readCodexTurns = opts.readCodexTurns ?? extractCodexPreviewTurns;

	if (ref.backend === "pi") {
		// D9: the ref IS the file path. One read, no discovery.
		return readPiTurns(ref.id);
	}

	// Codex: find the one filename carrying this thread id, then read only it.
	const root = opts.codexRoot ?? SESSION_ROOTS.codex;
	const files = await findFiles(root);
	const match = files.find((file) => fileMatchesThreadId(file, ref.id));
	if (!match) return [];
	return readCodexTurns(match);
}
