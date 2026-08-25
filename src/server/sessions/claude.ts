/**
 * Claude Code session file -> SessionSummary (OW-votasi).
 *
 * Store: `~/.claude/projects/<munged-cwd>/<uuid>.jsonl`, one file per session,
 * verified on the home server 2026-08-25 against files written by claude
 * 2.1.228-2.1.238. There is no header line: the directory name munges `/` to
 * `-` lossily (worktree paths produce `--`), so `cwd`, `sessionId`, and the
 * first `timestamp` are read from whichever message line carries them --
 * files open with any of user/queue-operation/mode/custom-title/ai-title
 * lines. In every real session file the first line's `sessionId` equals the
 * filename stem (110/110 in the census); the filename is the fallback.
 *
 * Line types seen in real transcripts: `assistant`, `user`, `ai-title`,
 * `custom-title`, `last-prompt`, `queue-operation`, `attachment`, `mode`,
 * `system`, `file-history-snapshot`, and more -- and Claude Code versions
 * weekly, so drift is a certainty, not a hedge. Unknown shapes are bucketed,
 * never thrown on, the same stance codex.ts takes toward header drift.
 *
 * Subagent transcripts are NOT inline here (unlike what OW-votasi expected):
 * they are separate files at `<munged-cwd>/<session-uuid>/subagents/
 * agent-*.jsonl` (149 of 259 files in the census), every message line of
 * which is `isSidechain: true`. `findClaudeSessionFiles` therefore never
 * descends below the project directory, and the parsers skip any stray
 * `isSidechain` line as well.
 *
 * Preview: first human message, like pi.ts/codex.ts -- NOT the `ai-title`
 * generated-title line the store also carries. Chosen because (a) only 53 of
 * the 110 real sessions in the census have any ai-title, so a title-led
 * preview is null half the time; (b) titles are regenerated as the session
 * grows, so the *current* one sits near the end of the file, outside the
 * bounded enumeration read -- honouring it properly wants a tail read, a
 * different mechanism; (c) it keeps the early-exit read pattern shared with
 * the other two parsers. First cut per the iterate-from-use rule: if titles
 * win in use, revisit.
 */

import type { Dirent, Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPreviewTurn, SessionSummary } from "../../shared/protocol.ts";
import { readLinesLfOnly } from "./line-reader.ts";
import { trimPreview } from "./text.ts";

/**
 * Claude Code injects wrapper content into "user"-role lines -- slash-command
 * envelopes, local-command output, hook/system reminders -- the same disease
 * `SYNTHETIC_USER_PREFIXES` in codex.ts treats. Census on this machine
 * (2026-08-25, 110 session files): every one of these prefixes appears in
 * real user-role lines, and none is something a human typed. A heuristic,
 * not a contract; expect it to grow.
 */
const SYNTHETIC_USER_PREFIXES = [
	"<system-reminder>",
	"<command-name>",
	"<command-message>",
	"<local-command-caveat>",
	"<local-command-stdout>",
	"<task-notification>",
	"[Request interrupted by user",
];

function isSyntheticBlock(text: string): boolean {
	const trimmed = text.trimStart();
	return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Session files under `<root>/<munged-cwd>/`, exactly two levels down.
 * Deliberately NOT the depth-agnostic `findJsonlFiles` walk: anything nested
 * deeper is per-session auxiliary data, not a session -- subagent transcripts
 * (`<munged-cwd>/<session-uuid>/subagents/agent-*.jsonl`, all-sidechain) and
 * `tool-results/` -- which a deep walk would surface as phantom sessions.
 */
export async function findClaudeSessionFiles(root: string): Promise<string[]> {
	let projectDirs: Dirent[];
	try {
		projectDirs = await readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch {
		// Missing root (no Claude Code sessions on this machine yet) -- treat as
		// "nothing here", never throw, matching findJsonlFiles.
		return [];
	}

	const out: string[] = [];
	for (const dir of projectDirs) {
		if (!dir.isDirectory()) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(join(root, dir.name), { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				out.push(join(root, dir.name, entry.name));
			}
		}
	}
	return out;
}

function tryParseRecord(line: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	return parsed as Record<string, unknown>;
}

/**
 * Text blocks of a non-sidechain message line for `role`, or null if the line
 * is not one. Content is either an Anthropic-shaped block array (`{type:
 * "text", text}` among thinking/tool_use/tool_result blocks) or, on plenty of
 * real user lines, a plain string.
 */
function extractMessageTexts(rec: Record<string, unknown>, role: "user" | "assistant"): string[] | null {
	if (rec.type !== role || rec.isSidechain === true) return null;
	const message = rec.message;
	if (typeof message !== "object" || message === null) return null;
	const msg = message as Record<string, unknown>;
	if (msg.role !== role) return null;

	const content = msg.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return null;

	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
		}
	}
	return texts;
}

function derivePreview(texts: string[]): string | null {
	const kept = texts.filter((t) => t.trim().length > 0 && !isSyntheticBlock(t));
	const joined = kept.join(" ").trim();
	return joined.length > 0 ? trimPreview(joined) : null;
}

/** Fallback id when no line carries a sessionId: the uuid the file is named after. */
function idFromFilename(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
	return match?.[1] ?? filePath;
}

export async function parseClaudeSession(filePath: string, stat: Stats): Promise<SessionSummary> {
	let id: string | null = null;
	let cwd: string | null = null;
	let createdAt: string | null = null;
	let preview: string | null = null;

	try {
		for await (const line of readLinesLfOnly(filePath)) {
			const rec = tryParseRecord(line);
			if (!rec) continue;
			// No header line: take each field from the first line that carries it.
			if (id === null && typeof rec.sessionId === "string") id = rec.sessionId;
			if (cwd === null && typeof rec.cwd === "string") cwd = rec.cwd;
			if (createdAt === null && typeof rec.timestamp === "string") createdAt = rec.timestamp;
			if (preview === null) {
				const texts = extractMessageTexts(rec, "user");
				if (texts) preview = derivePreview(texts);
			}
			if (id !== null && cwd !== null && createdAt !== null && preview !== null) break;
		}
	} catch {
		// Unreadable file (deleted mid-walk, permission error, ...). Enumeration
		// tolerates a single bad file; fall through with whatever was found.
	}

	return {
		ref: { backend: "claude", id: id ?? idFromFilename(filePath) },
		cwd,
		preview,
		createdAt,
		updatedAt: stat.mtime.toISOString(),
		status: "detached",
		isStreaming: false,
	};
}

/**
 * The full text conversation of a stored Claude Code session, flattened for
 * the read-only preview (OW-38). Sibling of `parseClaudeSession`'s `preview`:
 * same file, same line reader, but it keeps every non-sidechain user and
 * assistant *text* block in order instead of stopping at the first real user
 * message. Thinking, tool_use, and tool_result blocks are dropped (see
 * `SessionPreviewResponse`); wrapper-only user turns are dropped via
 * `isSyntheticBlock`, matching the enumeration heuristic.
 */
export async function extractClaudePreviewTurns(filePath: string): Promise<SessionPreviewTurn[]> {
	const turns: SessionPreviewTurn[] = [];
	// Unbounded: unlike enumeration, the preview must reach the real end of the
	// file (attaching already shows the whole transcript, so the preview
	// stopping early at the enumeration caps would be a visible regression).
	for await (const line of readLinesLfOnly(filePath, { maxLines: Infinity, maxBytes: Infinity })) {
		const rec = tryParseRecord(line);
		if (!rec) continue;
		const turn = extractTextTurn(rec);
		if (turn) turns.push(turn);
	}
	return turns;
}

/** One text turn from a Claude Code message line, or null if it carries no display text. */
function extractTextTurn(rec: Record<string, unknown>): SessionPreviewTurn | null {
	const role = rec.type === "user" ? "user" : rec.type === "assistant" ? "assistant" : null;
	if (!role) return null;
	const texts = extractMessageTexts(rec, role);
	if (!texts) return null;

	// A user turn that is entirely harness-injected wrapper content is not
	// something a human said; drop it, matching the preview heuristic. Assistant
	// text never carries these wrappers.
	const kept = role === "user" ? texts.filter((t) => !isSyntheticBlock(t)) : texts;
	const text = kept.join("").trim();
	if (text.length === 0) return null;
	const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
	return { role, text, ...(timestamp ? { timestamp } : {}) };
}
