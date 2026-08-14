/**
 * Codex session file -> SessionSummary, reading only what enumeration needs.
 *
 * Header: HANDOFF finding 18/20 -- current files start
 * `{"type":"session_meta","payload":{id,cwd,timestamp,...}}`; 5 of 583 files
 * on this machine use an older bare `{id,timestamp}` header with no `cwd`.
 * Both are handled; anything else is bucketed unknown rather than thrown.
 *
 * Preview: see SYNTHETIC_USER_PREFIXES below -- this is the one place this
 * module goes beyond what DESIGN/HANDOFF describe, because "first user
 * message" turned out not to mean what it sounds like for Codex. Flagged in
 * the agent report.
 */

import type { Stats } from "node:fs";
import type { SessionPreviewTurn, SessionSummary } from "../../shared/protocol.ts";
import { readLinesLfOnly } from "./line-reader.ts";
import { trimPreview } from "./text.ts";

/**
 * Codex (and whatever harness/plugin set is active) injects wrapper content
 * into the first several "user"-role turns of nearly every real session:
 * AGENTS.md dumps, `<environment_context>`, permission/apps/skills
 * instructions, `<recommended_plugins>`, project `<user_instructions>`. None
 * of it is something a human typed.
 *
 * Census on this machine (2026-08-11, 583 files): a random sample of 20
 * sessions found the first user-role item was *entirely* synthetic wrapper
 * content in 18/20 of them; the real first human message was typically the
 * second or third user-role item, several hundred to several thousand bytes
 * in. Naively using "the first user message" as DESIGN/HANDOFF describe it
 * would show a system-prompt dump as the preview almost every time.
 *
 * This prefix list is therefore a heuristic, not a documented contract, and
 * will need to grow as injected wrapper content drifts -- same spirit as the
 * header-format drift D9 already calls out for the session header itself.
 */
const SYNTHETIC_USER_PREFIXES = [
	"<environment_context>",
	"<permissions instructions>",
	"<apps_instructions>",
	"<skills_instructions>",
	"<user_instructions>",
	"<recommended_plugins>",
	"# AGENTS.md instructions",
	"<INSTRUCTIONS>",
];

function isSyntheticBlock(text: string): boolean {
	const trimmed = text.trimStart();
	return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

interface ParsedHeader {
	id: string | null;
	cwd: string | null;
	createdAt: string | null;
}

const EMPTY_HEADER: ParsedHeader = { id: null, cwd: null, createdAt: null };

function parseHeader(line: string): ParsedHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return EMPTY_HEADER;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY_HEADER;
	const rec = parsed as Record<string, unknown>;

	// Current format.
	if (rec.type === "session_meta" && typeof rec.payload === "object" && rec.payload !== null) {
		const payload = rec.payload as Record<string, unknown>;
		return {
			id: typeof payload.id === "string" ? payload.id : null,
			cwd: typeof payload.cwd === "string" ? payload.cwd : null,
			createdAt: typeof payload.timestamp === "string" ? payload.timestamp : null,
		};
	}

	// Drifted older format: bare {id,timestamp}, no "type", no cwd.
	if (typeof rec.id === "string") {
		return {
			id: rec.id,
			cwd: null,
			createdAt: typeof rec.timestamp === "string" ? rec.timestamp : null,
		};
	}

	// Unrecognised header shape -- never throw; caller falls back to filename.
	return EMPTY_HEADER;
}

/** Text blocks of a user-role message, in either the current or old shape. */
function extractUserMessageTexts(line: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;

	let role: unknown;
	let content: unknown;
	if (rec.type === "response_item" && typeof rec.payload === "object" && rec.payload !== null) {
		const payload = rec.payload as Record<string, unknown>;
		if (payload.type === "message") {
			role = payload.role;
			content = payload.content;
		}
	} else if (rec.type === "message") {
		// Drifted older format: flat {type:"message",role,content}.
		role = rec.role;
		content = rec.content;
	}

	if (role !== "user" || !Array.isArray(content)) return null;

	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const text = (block as Record<string, unknown>).text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts;
}

function derivePreview(texts: string[]): string | null {
	const kept = texts.filter((t) => t.trim().length > 0 && !isSyntheticBlock(t));
	const joined = kept.join(" ").trim();
	return joined.length > 0 ? trimPreview(joined) : null;
}

/** Fallback id when the header carries none: pull the uuid out of the filename. */
function idFromFilename(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
	return match?.[1] ?? filePath;
}

export async function parseCodexSession(filePath: string, stat: Stats): Promise<SessionSummary> {
	let header: ParsedHeader = EMPTY_HEADER;
	let preview: string | null = null;

	try {
		let lineNo = 0;
		for await (const line of readLinesLfOnly(filePath)) {
			lineNo++;
			if (lineNo === 1) {
				header = parseHeader(line);
				continue;
			}
			const texts = extractUserMessageTexts(line);
			if (!texts) continue;
			const candidate = derivePreview(texts);
			if (candidate) {
				preview = candidate;
				break;
			}
		}
	} catch {
		// Unreadable file (deleted mid-walk, permission error, ...). Enumeration
		// tolerates a single bad file; fall through with whatever was found.
	}

	return {
		ref: { backend: "codex", id: header.id ?? idFromFilename(filePath) },
		cwd: header.cwd,
		preview,
		createdAt: header.createdAt,
		updatedAt: stat.mtime.toISOString(),
		status: "detached",
		isStreaming: false,
	};
}

/**
 * The full text conversation of a stored Codex session, flattened for the
 * read-only preview (OW-38). Sibling of `parseCodexSession`'s `preview`: same
 * file, same line reader, but it keeps every user and assistant *text* block in
 * order instead of stopping at the first real user message.
 *
 * The synthetic-block filtering (`isSyntheticBlock`) is reused so the
 * harness-injected wrappers -- `<environment_context>`, AGENTS.md dumps, and
 * the rest -- do not surface as conversation turns. Assistant text carries no
 * such wrappers, so it is kept verbatim. Reasoning, tool calls, and tool
 * results are dropped (see `SessionPreviewResponse`).
 */
export async function extractCodexPreviewTurns(filePath: string): Promise<SessionPreviewTurn[]> {
	const turns: SessionPreviewTurn[] = [];
	let lineNo = 0;
	for await (const line of readLinesLfOnly(filePath)) {
		lineNo++;
		if (lineNo === 1) continue;
		const turn = extractTextTurn(line);
		if (turn) turns.push(turn);
	}
	return turns;
}

/**
 * One text turn from a Codex message line, or null if it carries no display
 * text. Handles both the current `response_item`-wrapped shape and the drifted
 * flat `{type:"message"}` shape, in either the `text` or `input_text`/
 * `output_text` block flavours.
 */
function extractTextTurn(line: string): SessionPreviewTurn | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;

	let role: unknown;
	let content: unknown;
	if (rec.type === "response_item" && typeof rec.payload === "object" && rec.payload !== null) {
		const payload = rec.payload as Record<string, unknown>;
		if (payload.type === "message") {
			role = payload.role;
			content = payload.content;
		}
	} else if (rec.type === "message") {
		role = rec.role;
		content = rec.content;
	}

	if ((role !== "user" && role !== "assistant") || !Array.isArray(content)) return null;

	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const text = (block as Record<string, unknown>).text;
			if (typeof text === "string") texts.push(text);
		}
	}

	// A user turn that is entirely harness-injected wrapper content is not
	// something a human said; drop it, matching the preview heuristic. Assistant
	// text never carries these wrappers.
	const kept = role === "user" ? texts.filter((t) => !isSyntheticBlock(t)) : texts;
	const text = kept.join("").trim();
	return text.length > 0 ? { role, text } : null;
}
