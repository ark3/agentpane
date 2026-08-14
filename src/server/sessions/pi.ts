/**
 * Pi session file -> SessionSummary.
 *
 * Header: HANDOFF finding 18 -- `{"type":"session",...,cwd}`. Census on this
 * machine found all 390 files consistent with this shape (no drift observed
 * yet, unlike Codex), but header parsing still degrades to unknown-workspace
 * rather than throwing if that ever changes.
 *
 * Unlike Codex, a random sample of 15 Pi sessions found the first "user"-role
 * message was always the real, human-typed first message (2-4 header/system
 * lines in, then the message) -- no synthetic wrapper turns observed. So no
 * filtering heuristic here; see codex.ts for why Codex needs one.
 */

import type { Stats } from "node:fs";
import type { SessionPreviewTurn, SessionSummary } from "../../shared/protocol.ts";
import { readLinesLfOnly } from "./line-reader.ts";
import { trimPreview } from "./text.ts";

interface ParsedHeader {
	cwd: string | null;
	createdAt: string | null;
}

const EMPTY_HEADER: ParsedHeader = { cwd: null, createdAt: null };

function parseHeader(line: string): ParsedHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return EMPTY_HEADER;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY_HEADER;
	const rec = parsed as Record<string, unknown>;
	if (rec.type !== "session") return EMPTY_HEADER;
	return {
		cwd: typeof rec.cwd === "string" ? rec.cwd : null,
		createdAt: typeof rec.timestamp === "string" ? rec.timestamp : null,
	};
}

function extractUserMessageTexts(line: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;
	if (rec.type !== "message") return null;

	const message = rec.message;
	if (typeof message !== "object" || message === null) return null;
	const msg = message as Record<string, unknown>;
	if (msg.role !== "user" || !Array.isArray(msg.content)) return null;

	const texts: string[] = [];
	for (const block of msg.content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
		}
	}
	return texts;
}

export async function parsePiSession(filePath: string, stat: Stats): Promise<SessionSummary> {
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
			const joined = texts
				.filter((t) => t.trim().length > 0)
				.join(" ")
				.trim();
			if (joined) {
				preview = trimPreview(joined);
				break;
			}
		}
	} catch {
		// Unreadable file -- tolerate, matching the Codex parser.
	}

	return {
		// DESIGN D9: Pi's session identity IS its JSONL path, not the header's
		// own `id` field.
		ref: { backend: "pi", id: filePath },
		cwd: header.cwd,
		preview,
		createdAt: header.createdAt,
		updatedAt: stat.mtime.toISOString(),
		status: "detached",
		isStreaming: false,
	};
}

/**
 * The full text conversation of a stored Pi session, flattened for the
 * read-only preview (OW-38). This is the sibling of `parsePiSession`'s
 * first-user-message `preview`: same file, same line reader, but it keeps every
 * user and assistant *text* block in order rather than stopping at the first.
 *
 * Deliberately narrow (see `SessionPreviewResponse`): thinking, tool calls, and
 * tool results are dropped, so an assistant turn that was only a tool call
 * contributes no turn at all. The header line is skipped like everywhere else.
 */
export async function extractPiPreviewTurns(filePath: string): Promise<SessionPreviewTurn[]> {
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

/** One text turn from a Pi `message` line, or null if it carries no display text. */
function extractTextTurn(line: string): SessionPreviewTurn | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;
	if (rec.type !== "message") return null;

	const message = rec.message;
	if (typeof message !== "object" || message === null) return null;
	const msg = message as Record<string, unknown>;
	// Only the two conversational roles; `toolResult` is not display text.
	if ((msg.role !== "user" && msg.role !== "assistant") || !Array.isArray(msg.content)) return null;

	const texts: string[] = [];
	for (const block of msg.content) {
		if (block && typeof block === "object") {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
		}
	}
	const text = texts.join("").trim();
	return text.length > 0 ? { role: msg.role, text } : null;
}
