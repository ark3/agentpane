/**
 * Claude Code wire payloads -> Pi message shapes, as pure functions.
 *
 * Claude's `assistant`/`user` events wrap Anthropic Message payloads, so this
 * is closer to identity than Codex's `ThreadItem` translation: thinking, text,
 * and tool_use blocks map 1:1 onto `AssistantMessage` content, and tool_result
 * user events map onto `ToolResultMessage`. The stateful merging (per-block
 * `assistant` events under one API `message.id`, streaming deltas) lives in
 * `reducer.ts`; nothing here holds state.
 */

import type {
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import {
	isRecord,
	type ClaudeContentBlock,
	type ClaudeToolResultBlock,
	type ClaudeUsage,
} from "./protocol.ts";

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
 * Claude reports no per-message cost (the `result` event's `total_cost_usd` is
 * turn-cumulative), so every cost field stays 0 -- a UI must not read "free"
 * into that, the same caveat the Codex mapping carries.
 */
export function usageFromClaude(usage: ClaudeUsage | undefined): Usage {
	const input = usage?.input_tokens ?? 0;
	const output = usage?.output_tokens ?? 0;
	const cacheRead = usage?.cache_read_input_tokens ?? 0;
	const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A wire content block narrowed, or null for shapes this adapter does not render. */
export function asContentBlock(value: unknown): ClaudeContentBlock | null {
	if (!isRecord(value)) return null;
	switch (value.type) {
		case "text":
			return typeof value.text === "string" ? { type: "text", text: value.text } : null;
		case "thinking":
			return {
				type: "thinking",
				thinking: typeof value.thinking === "string" ? value.thinking : "",
				...(typeof value.signature === "string" ? { signature: value.signature } : {}),
			};
		case "tool_use":
			if (typeof value.id !== "string" || typeof value.name !== "string") return null;
			return { type: "tool_use", id: value.id, name: value.name, input: value.input };
		case "tool_result":
			if (typeof value.tool_use_id !== "string") return null;
			return {
				type: "tool_result",
				tool_use_id: value.tool_use_id,
				content: value.content as ClaudeToolResultBlock["content"],
				...(typeof value.is_error === "boolean" ? { is_error: value.is_error } : {}),
			};
		default:
			// Unknown block types (Claude Code versions weekly) are dropped, not
			// thrown on -- same stance the store parser takes.
			return null;
	}
}

/** `message.content` normalised to blocks; a plain string becomes one text block. */
export function contentBlocksOf(content: string | unknown[] | undefined): ClaudeContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.map(asContentBlock).filter((block): block is ClaudeContentBlock => block !== null);
}

/** An assistant-side wire block -> the Pi content block it becomes. */
export function assistantBlockToContent(
	block: ClaudeContentBlock,
): TextContent | ThinkingContent | ToolCall | null {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.signature ? { thinkingSignature: block.signature } : {}),
			};
		case "tool_use":
			return {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: isRecord(block.input) ? block.input : {},
			};
		default:
			return null;
	}
}

/**
 * A tool_result block's `content` -> Pi tool-result content blocks. The wire
 * carries either a bare string or an array of text blocks; anything else
 * degrades to its JSON text.
 */
export function toolResultContent(
	content: ClaudeToolResultBlock["content"],
): (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const out: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			out.push({ type: "text", text: block.text });
		} else if (
			isRecord(block) &&
			block.type === "image" &&
			isRecord(block.source) &&
			typeof block.source.data === "string"
		) {
			out.push({
				type: "image",
				data: block.source.data,
				mimeType:
					typeof block.source.media_type === "string" ? block.source.media_type : "image/png",
			});
		} else {
			out.push({ type: "text", text: JSON.stringify(block) });
		}
	}
	return out;
}

/** Anthropic `stop_reason` -> Pi `StopReason`. */
export function mapStopReason(stopReason: string | null | undefined): "stop" | "toolUse" | "length" {
	switch (stopReason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}
