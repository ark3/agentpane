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
import { storedAgentMessage } from "./preview-message.ts";
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
 * The full transcript of a stored Codex session for the read-only preview
 * (OW-38). Codex stores Responses API `response_item` payloads, not the live
 * `ThreadItem` shape, so this module maps those store variants directly. The
 * synthetic user filtering remains shared with enumeration.
 */
export async function extractCodexPreviewTurns(filePath: string): Promise<SessionPreviewTurn[]> {
	const turns: SessionPreviewTurn[] = [];
	const toolNames = new Map<string, string>();
	let lineNo = 0;
	// Unbounded: unlike enumeration, the preview must reach the real end of the
	// file (attaching already shows the whole transcript, so the preview
	// stopping early at the enumeration caps would be a visible regression).
	for await (const line of readLinesLfOnly(filePath, { maxLines: Infinity, maxBytes: Infinity })) {
		lineNo++;
		if (lineNo === 1) continue;
		const turn = extractStoreTurn(line, toolNames);
		if (turn) turns.push(turn);
	}
	return turns;
}

/**
 * One transcript message from a Codex store line. Current stores wrap a
 * Responses API item in `response_item`; the drifted flat message form remains
 * accepted for old sessions.
 */
function extractStoreTurn(
	line: string,
	toolNames: Map<string, string>,
): SessionPreviewTurn | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;

	let payload: Record<string, unknown> | null = null;
	if (rec.type === "response_item" && typeof rec.payload === "object" && rec.payload !== null) {
		payload = rec.payload as Record<string, unknown>;
	} else if (rec.type === "message") {
		payload = rec;
	}
	if (!payload) return null;
	const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

	if (payload.type === "message") {
		const role = payload.role;
		if ((role !== "user" && role !== "assistant") || !Array.isArray(payload.content)) return null;
		const content = payload.content
			.map(codexMessageBlock)
			.filter((block): block is Record<string, unknown> => block !== null)
			.filter((block) => role !== "user" || block.type !== "text" || !isSyntheticBlock(block.text as string));
		if (content.length === 0) return null;
		return storedAgentMessage(
			{ role, content },
			timestamp,
			CODEX_PREVIEW_IDENTITY,
		);
	}

	if (payload.type === "reasoning") {
		const thinking = [...textParts(payload.summary), ...textParts(payload.content)]
			.map((part) => part.trim())
			.filter(Boolean)
			.join("\n\n");
		if (!thinking) return null;
		return assistantPreview([{ type: "thinking", thinking }], timestamp);
	}

	if (payload.type === "function_call" || payload.type === "custom_tool_call") {
		if (typeof payload.call_id !== "string" || typeof payload.name !== "string") return null;
		const name = typeof payload.namespace === "string"
			? `${payload.namespace}__${payload.name}`
			: payload.name;
		toolNames.set(payload.call_id, name);
		const rawArguments = payload.type === "function_call" ? payload.arguments : payload.input;
		return assistantPreview([
			{
				type: "toolCall",
				id: payload.call_id,
				name,
				arguments: parseArguments(rawArguments),
			},
		], timestamp, "toolUse");
	}

	if (payload.type === "local_shell_call") {
		const id = typeof payload.call_id === "string"
			? payload.call_id
			: typeof payload.id === "string"
				? payload.id
				: null;
		if (!id) return null;
		const action = typeof payload.action === "object" && payload.action !== null
			? payload.action as Record<string, unknown>
			: {};
		const command = Array.isArray(action.command)
			? action.command.filter((part): part is string => typeof part === "string").join(" ")
			: "";
		toolNames.set(id, "bash");
		return assistantPreview([
			{
				type: "toolCall",
				id,
				name: "bash",
				arguments: {
					command,
					cwd: typeof action.working_directory === "string" ? action.working_directory : null,
				},
			},
		], timestamp, "toolUse");
	}

	if (payload.type === "web_search_call") {
		if (typeof payload.id !== "string") return null;
		toolNames.set(payload.id, "web_search");
		return assistantPreview([
			{
				type: "toolCall",
				id: payload.id,
				name: "web_search",
				arguments: typeof payload.action === "object" && payload.action !== null
					? payload.action as Record<string, unknown>
					: {},
			},
		], timestamp, "toolUse");
	}

	if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
		if (typeof payload.call_id !== "string") return null;
		const name = toolNames.get(payload.call_id) ??
			(typeof payload.name === "string" ? payload.name : "");
		return storedAgentMessage(
			{
				role: "toolResult",
				toolCallId: payload.call_id,
				toolName: name,
				content: outputContent(payload.output),
				isError: false,
			},
			timestamp,
			CODEX_PREVIEW_IDENTITY,
		);
	}

	if (payload.type === "context_compaction" || payload.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: "",
			tokensBefore: 0,
			...(timestamp ? { timestamp } : {}),
		} as SessionPreviewTurn;
	}

	return null;
}

const CODEX_PREVIEW_IDENTITY = {
	api: "openai-responses",
	provider: "openai",
	model: "codex",
} as const;

function assistantPreview(
	content: Record<string, unknown>[],
	timestamp: string | undefined,
	stopReason: "stop" | "toolUse" = "stop",
): SessionPreviewTurn | null {
	return storedAgentMessage(
		{ role: "assistant", content, stopReason },
		timestamp,
		CODEX_PREVIEW_IDENTITY,
	);
}

function textParts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((part) => {
		if (typeof part === "string") return [part];
		if (typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string") {
			return [(part as Record<string, unknown>).text as string];
		}
		return [];
	});
}

function codexMessageBlock(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	const block = value as Record<string, unknown>;
	if (
		(block.type === "input_text" || block.type === "output_text" || block.type === "text") &&
		typeof block.text === "string"
	) {
		return { type: "text", text: block.text };
	}
	if (block.type === "input_image" && typeof block.image_url === "string") {
		return imageBlock(block.image_url);
	}
	if (block.type === "input_audio" && typeof block.audio_url === "string") {
		return { type: "text", text: `[audio: ${block.audio_url}]` };
	}
	return null;
}

function imageBlock(url: string): Record<string, unknown> {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	return match?.[1] && match[2] !== undefined
		? { type: "image", mimeType: match[1], data: match[2] }
		: { type: "text", text: `[image: ${url}]` };
}

function parseArguments(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: { value: parsed };
	} catch {
		return { value };
	}
}

function outputContent(value: unknown): Record<string, unknown>[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [{ type: "text", text: JSON.stringify(value) }];
	return value.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const block = part as Record<string, unknown>;
		if (block.type === "input_text" && typeof block.text === "string") {
			return [{ type: "text", text: block.text }];
		}
		if (block.type === "input_image" && typeof block.image_url === "string") {
			return [imageBlock(block.image_url)];
		}
		return [{ type: "text", text: JSON.stringify(block) }];
	});
}
