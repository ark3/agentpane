/**
 * Render-side type aliases.
 *
 * D6 keeps `AgentMessage` as the internal contract, and D10 says the pi
 * packages are types only -- every import here is `import type`, so nothing
 * from them reaches the bundle (`src/import-boundaries.test.ts` enforces it).
 */

import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";

/**
 * The real rendering unit (D5). An assistant message carries text / thinking /
 * toolCall blocks; a user message carries text / image. `Block.svelte`
 * dispatches over the union of both, so one component covers every role.
 */
export type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

/** Props every tool renderer in the registry receives. */
export interface ToolRenderProps {
	/** The `toolCall` block from the assistant message. */
	call: ToolCall;
	/**
	 * The `ToolResultMessage` answering this call, if it has arrived. Absent
	 * means the tool is still running (or the transcript is truncated).
	 */
	result?: ToolResultMessage | undefined;
	/** True while the turn that owns this call is still streaming. */
	streaming?: boolean | undefined;
}

/** Visual state of a tool card, derived once and shared by every renderer. */
export type ToolState = "running" | "ok" | "error";

export function toolState(props: ToolRenderProps): ToolState {
	if (props.result) return props.result.isError ? "error" : "ok";
	return props.streaming ? "running" : "ok";
}

/** Concatenated text of a tool result, ignoring image parts. */
export function resultText(result: ToolResultMessage | undefined): string {
	if (!result) return "";
	return result.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** `AssistantMessage.stopReason === "pending"` is how Pi marks a live turn. */
export function isPending(message: AssistantMessage): boolean {
	return message.stopReason === "pending";
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One-line, whitespace-collapsed form for a card summary. */
export function oneLine(text: string, max = 120): string {
	return truncate(text.replace(/\s+/g, " ").trim(), max);
}

export function basename(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}
