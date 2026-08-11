/**
 * Codex `ThreadItem` -> Pi `AgentMessage`, as pure functions.
 *
 * DESIGN calls this "the one piece of genuine engineering", and the reason it
 * lives in its own module with no I/O is that the whole of it is then testable
 * against `resources/fixtures/codex/*.jsonl` with zero subprocesses.
 *
 * The central trick: **a mapped item is a pure function of its current
 * `ThreadItem`.** Streaming is not modelled here at all. The reducer keeps the
 * latest `ThreadItem` per id, applies each delta to that stored item, and
 * re-runs `mapItem`. So `item/started`, every delta, and the authoritative
 * `item/completed` all take the same path, and there is exactly one place
 * where a Codex item turns into messages.
 */

import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parsePatch } from "diff";
import { isRecord } from "./protocol.ts";
import type {
	CodexItem,
	FileUpdateChange,
	JsonValue,
	ThreadItem,
	TokenUsageBreakdown,
	UserInput,
} from "./protocol.ts";

/**
 * Tool names we present for Codex's built-in tool-ish items.
 *
 * These are the keys the client's tool-renderer registry dispatches on (D5),
 * so they are a cross-workstream seam and deliberately live in one constant.
 *
 * `commandExecution` is deliberately called `bash`: Pi picks its `bash` tool
 * for the same job (HANDOFF finding 24) with the same `{command}` argument
 * shape, so one renderer serves both backends. `fileChange` uses the render
 * registry's `edit` contract; `fileChangeArguments` translates Codex's unified
 * diffs into that renderer's nested `edits[]` shape.
 */
export const CODEX_TOOL_NAMES = {
	commandExecution: "bash",
	fileChange: "edit",
	webSearch: "web_search",
} as const;

/** What a Codex `ThreadItem` becomes. Tool-ish items become a *pair*, like Pi's. */
export type MappedItem =
	| { kind: "single"; message: AgentMessage }
	| { kind: "tool"; call: AssistantMessage; result: ToolResultMessage | null }
	/** Nothing to show yet (or ever). `reason` is for diagnostics only. */
	| { kind: "none"; reason: string };

/** Everything `mapItem` needs that is not on the item itself. */
export interface MapContext {
	/** Milliseconds; the item's own `startedAtMs`/`completedAtMs` when we have one. */
	timestamp: number;
	/** Stamped onto every `AssistantMessage`; `AssistantMessage` requires all three. */
	api: string;
	provider: string;
	model: string;
	/** False for `item/started` and deltas; true for authoritative completion/hydration. */
	completed: boolean;
}

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function emptyUsage(): Usage {
	return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
}

/**
 * Codex's `inputTokens` is inclusive of cached and cache-write tokens (checked
 * against the fixtures: `total = inputTokens + outputTokens`), while Pi's
 * `Usage.input` sits alongside `cacheRead`/`cacheWrite`. So subtract.
 *
 * Codex reports no cost at all, so every cost field stays 0 -- a UI must not
 * read "free" into that.
 */
export function usageFromBreakdown(b: TokenUsageBreakdown): Usage {
	const cacheRead = b.cachedInputTokens;
	const cacheWrite = b.cacheWriteInputTokens;
	return {
		input: Math.max(0, b.inputTokens - cacheRead - cacheWrite),
		output: b.outputTokens,
		cacheRead,
		cacheWrite,
		reasoning: b.reasoningOutputTokens,
		totalTokens: b.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** `data:image/png;base64,...` -> an `ImageContent`; anything else stays a reference. */
function imageFromUrl(url: string): ImageContent | TextContent {
	const match = DATA_URL.exec(url);
	if (match?.[1] && match[2] !== undefined) return { type: "image", data: match[2], mimeType: match[1] };
	return { type: "text", text: `[image: ${url}]` };
}

/**
 * Codex `UserInput` -> Pi user content blocks.
 *
 * NOTE: DESIGN's content-block row ("`input_text`/`output_text` -> TextContent")
 * describes `ContentItem`, the *legacy* type. v2 `ThreadItem.userMessage`
 * carries `UserInput`, whose variants are `text`/`image`/`localImage`/`audio`/
 * `localAudio`/`skill`/`mention`. The fixtures confirm `{"type":"text"}`.
 *
 * `localImage`/`localAudio` reference a path the server can read but this
 * reducer cannot (it is pure), so they degrade to a text reference.
 */
export function userInputToContent(inputs: UserInput[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const input of inputs) {
		switch (input.type) {
			case "text":
				out.push({ type: "text", text: input.text });
				break;
			case "image":
				out.push(imageFromUrl(input.url));
				break;
			case "localImage":
				out.push({ type: "text", text: `[image: ${input.path}]` });
				break;
			case "audio":
				out.push({ type: "text", text: `[audio: ${input.url}]` });
				break;
			case "localAudio":
				out.push({ type: "text", text: `[audio: ${input.path}]` });
				break;
			case "skill":
				out.push({ type: "text", text: `[skill: ${input.name}]` });
				break;
			case "mention":
				out.push({ type: "text", text: `@${input.name}` });
				break;
		}
	}
	return out;
}

/** MCP content blocks are opaque JSON at the protocol boundary; do the obvious mapping. */
function mcpContentToBlocks(content: JsonValue[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			out.push({ type: "text", text: block });
			continue;
		}
		if (!isRecord(block)) continue;
		if (block["type"] === "text" && typeof block["text"] === "string") {
			out.push({ type: "text", text: block["text"] });
		} else if (block["type"] === "image" && typeof block["data"] === "string") {
			out.push({
				type: "image",
				data: block["data"],
				mimeType: typeof block["mimeType"] === "string" ? block["mimeType"] : "image/png",
			});
		} else {
			out.push({ type: "text", text: JSON.stringify(block) });
		}
	}
	return out;
}

function textBlocks(text: string): TextContent[] {
	return [{ type: "text", text }];
}

interface EditHunk {
	oldText: string;
	newText: string;
}

function sideOfHunk(lines: string[], omittedPrefix: "+" | "-"): string {
	return lines
		.filter((line) => !line.startsWith(omittedPrefix) && !line.startsWith("\\"))
		.map((line) => line.slice(1))
		.join("\n");
}

function editsFromDiff(diff: string): EditHunk[] {
	try {
		return parsePatch(diff).flatMap((patch) =>
			patch.hunks.map((hunk) => ({
				oldText: sideOfHunk(hunk.lines, "+"),
				newText: sideOfHunk(hunk.lines, "-"),
			})),
		);
	} catch {
		return [];
	}
}

function fileChangeArguments(changes: FileUpdateChange[]): Record<string, unknown> {
	return {
		path: changes[0]?.path ?? "",
		edits: changes.flatMap((change) => editsFromDiff(change.diff)),
		changes: changes.map((change) => ({
			path: change.path,
			kind: change.kind.type,
			diff: change.diff,
		})),
	};
}

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

function assistant(
	ctx: MapContext,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: ctx.api,
		provider: ctx.provider,
		model: ctx.model,
		usage: emptyUsage(),
		stopReason,
		timestamp: ctx.timestamp,
	};
}

function toolPair(
	ctx: MapContext,
	call: ToolCall,
	result: Omit<ToolResultMessage, "role" | "toolCallId" | "toolName" | "timestamp">,
): MappedItem {
	return {
		kind: "tool",
		call: assistant(ctx, [call], ctx.completed ? "toolUse" : "pending"),
		result: ctx.completed
			? {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					timestamp: ctx.timestamp,
					...result,
				}
			: null,
	};
}

function asArguments(value: JsonValue): Record<string, unknown> {
	if (isRecord(value)) return value;
	return { value };
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/** Item types we knowingly produce no message for; anything else is genuinely unknown. */
const SILENT_ITEM_TYPES = new Set<string>([
	// No payload at all beyond an id -- see `mapContextCompaction` note below.
	"contextCompaction",
	"hookPrompt",
	"enteredReviewMode",
	"exitedReviewMode",
	"subAgentActivity",
	"sleep",
]);

/**
 * The whole table, in one switch. Unknown item types return `kind: "none"`
 * rather than throwing: `ThreadItem` has 17 variants today and Codex adds them
 * between releases, so a reducer that crashes on an unrecognised item would
 * take the session down on a routine `codex` upgrade.
 */
export function mapItem(item: ThreadItem, ctx: MapContext): MappedItem {
	switch (item.type) {
		case "userMessage": {
			const message: UserMessage = {
				role: "user",
				content: userInputToContent(item.content),
				timestamp: ctx.timestamp,
			};
			return { kind: "single", message };
		}

		case "agentMessage": {
			// `phase` is "commentary" | "final_answer" | null. It is *not* a
			// reliable stop reason -- providers do not emit it consistently
			// (see MessagePhase's own doc comment) -- so it does not drive
			// stopReason; it is preserved as-is for a renderer that wants it.
			return {
				kind: "single",
				message: assistant(ctx, textBlocks(item.text), ctx.completed ? "stop" : "pending"),
			};
		}

		case "reasoning": {
			const thinking = reasoningText(item);
			// Hidden reasoning: Codex emits started+completed with empty
			// summary AND content (every fixture does this). Materialising a
			// message for that would put an empty bubble in every transcript,
			// so a reasoning item only becomes a message once it has text.
			if (!thinking) return { kind: "none", reason: "empty reasoning" };
			return {
				kind: "single",
				message: assistant(
					ctx,
					[{ type: "thinking", thinking }],
					ctx.completed ? "stop" : "pending",
				),
			};
		}

		case "plan": {
			// DESIGN leaves plan rendering open ("assistant text or a custom
			// block"). Text is the honest minimum: it is literally a text field.
			return {
				kind: "single",
				message: assistant(ctx, textBlocks(item.text), ctx.completed ? "stop" : "pending"),
			};
		}

		case "commandExecution": {
			const failed = item.status === "failed" || item.status === "declined";
			return toolPair(
				ctx,
				{
					type: "toolCall",
					id: item.id,
					name: CODEX_TOOL_NAMES.commandExecution,
					arguments: { command: item.command, cwd: item.cwd },
				},
				{
					content: textBlocks(item.aggregatedOutput ?? ""),
					isError: failed || (item.exitCode !== null && item.exitCode !== 0),
					details: {
						status: item.status,
						exitCode: item.exitCode,
						durationMs: item.durationMs,
						cwd: item.cwd,
						source: item.source,
						commandActions: item.commandActions,
					},
				},
			);
		}

		case "fileChange": {
			const changes = item.changes;
			return toolPair(
				ctx,
				{
					type: "toolCall",
					id: item.id,
					name: CODEX_TOOL_NAMES.fileChange,
					arguments: fileChangeArguments(changes),
				},
				{
					// The unified diff Codex already computed, one hunk set per
					// file. The `diff` package (D5) is for *rendering* this, not
					// for recomputing it.
					content: textBlocks(changes.map((c) => `--- ${c.path}\n${c.diff}`).join("\n")),
					isError: item.status === "failed" || item.status === "declined",
					details: { status: item.status, changes },
				},
			);
		}

		case "mcpToolCall": {
			const name = `${item.server}__${item.tool}`;
			const errored = item.status === "failed" || item.error !== null;
			const content = item.error
				? textBlocks(item.error.message)
				: mcpContentToBlocks(item.result?.content ?? []);
			return toolPair(
				ctx,
				{ type: "toolCall", id: item.id, name, arguments: asArguments(item.arguments) },
				{
					content,
					isError: errored,
					details: {
						status: item.status,
						server: item.server,
						tool: item.tool,
						durationMs: item.durationMs,
						structuredContent: item.result?.structuredContent ?? null,
					},
				},
			);
		}

		case "dynamicToolCall": {
			const name = item.namespace ? `${item.namespace}__${item.tool}` : item.tool;
			const content: (TextContent | ImageContent)[] = [];
			for (const part of item.contentItems ?? []) {
				if (part.type === "inputText") content.push({ type: "text", text: part.text });
				else if (part.type === "inputImage") content.push(imageFromUrl(part.imageUrl));
				else if (part.type === "inputAudio") content.push({ type: "text", text: `[audio: ${part.audioUrl}]` });
			}
			return toolPair(
				ctx,
				{ type: "toolCall", id: item.id, name, arguments: asArguments(item.arguments) },
				{
					content,
					isError: item.status === "failed" || item.success === false,
					details: { status: item.status, namespace: item.namespace, tool: item.tool },
				},
			);
		}

		case "webSearch": {
			const results = item.results ?? [];
			return toolPair(
				ctx,
				{
					type: "toolCall",
					id: item.id,
					name: CODEX_TOOL_NAMES.webSearch,
					arguments: { query: item.query },
				},
				{
					content: textBlocks(results.length ? JSON.stringify(results, null, 2) : ""),
					isError: false,
					details: { action: item.action, results },
				},
			);
		}

		case "imageGeneration": {
			// `result` is the generated image (a data URL or a path).
			const block = imageFromUrl(item.result);
			return {
				kind: "single",
				message: assistant(ctx, [blockAsAssistant(block)], ctx.completed ? "stop" : "pending"),
			};
		}

		case "imageView": {
			return {
				kind: "single",
				message: assistant(
					ctx,
					textBlocks(`[image: ${item.path}]`),
					ctx.completed ? "stop" : "pending",
				),
			};
		}

		default: {
			const type = item.type;
			return {
				kind: "none",
				reason: SILENT_ITEM_TYPES.has(type) ? `unrendered item type: ${type}` : `unknown item type: ${type}`,
			};
		}
	}
}

/** `AssistantMessage.content` cannot hold an image block; describe it instead. */
function blockAsAssistant(block: TextContent | ImageContent): TextContent {
	return block.type === "text" ? block : { type: "text", text: `[image: ${block.mimeType}]` };
}

/**
 * Reasoning carries two parallel string arrays: `summary` (the user-visible
 * summary, streamed by `item/reasoning/summaryTextDelta`) and `content` (raw
 * reasoning text, streamed by `item/reasoning/textDelta`). Both are shown, in
 * that order; empty entries drop out.
 */
export function reasoningText(item: CodexItem<"reasoning">): string {
	return [...item.summary, ...item.content]
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
}
