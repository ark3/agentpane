import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { SessionPreviewTurn } from "../../shared/protocol.ts";

export interface PreviewAssistantIdentity {
	api: AssistantMessage["api"];
	provider: AssistantMessage["provider"];
	model: string;
}

export function emptyPreviewUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function timestampField(timestamp: string | undefined): { timestamp?: string } {
	return timestamp === undefined ? {} : { timestamp };
}

function textOrImageBlock(value: unknown): TextContent | ImageContent | null {
	if (!isRecord(value)) return null;
	if (value.type === "text" && typeof value.text === "string") {
		return { ...value, type: "text", text: value.text } as TextContent;
	}
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
		return { ...value, type: "image", data: value.data, mimeType: value.mimeType } as ImageContent;
	}
	return null;
}

function assistantBlock(value: unknown): TextContent | ThinkingContent | ToolCall | null {
	const display = textOrImageBlock(value);
	if (display?.type === "text") return display;
	if (!isRecord(value)) return null;
	if (value.type === "thinking" && typeof value.thinking === "string") {
		return { ...value, type: "thinking", thinking: value.thinking } as ThinkingContent;
	}
	if (
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	) {
		return { ...value, type: "toolCall", id: value.id, name: value.name, arguments: value.arguments } as ToolCall;
	}
	return null;
}

/** Map a message-shaped store payload (Pi's native shape) onto the preview wire. */
export function storedAgentMessage(
	value: unknown,
	timestamp: string | undefined,
	identity: PreviewAssistantIdentity,
): SessionPreviewTurn | null {
	if (!isRecord(value)) return null;
	switch (value.role) {
		case "user": {
			const content =
				typeof value.content === "string"
					? value.content
					: Array.isArray(value.content)
						? value.content.map(textOrImageBlock).filter((block) => block !== null)
						: null;
			if (content === null) return null;
			return { role: "user", content, ...timestampField(timestamp) };
		}
		case "assistant": {
			if (!Array.isArray(value.content)) return null;
			const content = value.content.map(assistantBlock).filter((block) => block !== null);
			const { timestamp: _storedTimestamp, ...stored } = value;
			return {
				...stored,
				role: "assistant",
				content,
				api: typeof value.api === "string" ? value.api : identity.api,
				provider: typeof value.provider === "string" ? value.provider : identity.provider,
				model: typeof value.model === "string" ? value.model : identity.model,
				usage: isRecord(value.usage)
					? (value.usage as unknown as Usage)
					: emptyPreviewUsage(),
				stopReason: typeof value.stopReason === "string" ? value.stopReason : "stop",
				...timestampField(timestamp),
			} as SessionPreviewTurn;
		}
		case "toolResult": {
			if (
				typeof value.toolCallId !== "string" ||
				typeof value.toolName !== "string" ||
				!Array.isArray(value.content)
			) return null;
			const { timestamp: _storedTimestamp, ...stored } = value;
			return {
				...stored,
				role: "toolResult",
				toolCallId: value.toolCallId,
				toolName: value.toolName,
				content: value.content.map(textOrImageBlock).filter((block) => block !== null),
				isError: value.isError === true,
				...timestampField(timestamp),
			} as SessionPreviewTurn;
		}
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: typeof value.summary === "string" ? value.summary : "",
				tokensBefore: typeof value.tokensBefore === "number" ? value.tokensBefore : 0,
				...timestampField(timestamp),
			} as SessionPreviewTurn;
		default:
			return null;
	}
}

/** Put reducer-produced epoch timestamps back into the preview wire's ISO shape. */
export function previewTurnsFromMessages(messages: AgentMessage[]): SessionPreviewTurn[] {
	return messages.map((message) => {
		const timestamp = Number.isFinite(message.timestamp)
			? new Date(message.timestamp).toISOString()
			: undefined;
		const { timestamp: _timestamp, ...rest } = message;
		return { ...rest, ...timestampField(timestamp) } as SessionPreviewTurn;
	});
}
