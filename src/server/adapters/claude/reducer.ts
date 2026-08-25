/**
 * The Claude Code stream-json event stream -> transcript state machine.
 *
 * Pure: parsed `ClaudeEvent`s in, effects out. No subprocess, no timers --
 * driven from `resources/fixtures/claude/*.jsonl` in a unit test, the same
 * stance as `codex/reducer.ts`.
 *
 * Assembly rules, settled live (docs/MANUAL_TESTING.md OW-yilabe):
 *
 * - `assistant` events arrive once per completed CONTENT BLOCK, not per
 *   message, all under one API `message.id` -- merge by that id. The k-th
 *   authoritative block of a message id lands at content position k.
 * - Streaming assembly comes from `stream_event` lines
 *   (`--include-partial-messages`): `message_start` opens an assistant
 *   message, `content_block_start`/`content_block_delta` build blocks by
 *   index, and the `assistant` events replace them authoritatively.
 * - Multiple `message_start`/`message_stop` cycles occur inside one logical
 *   turn (one per API round-trip); only `result` ends the turn.
 * - Tool results come back as `user` events wrapping `tool_result` blocks,
 *   correlated by `tool_use_id`.
 * - The CLI never echoes the human's own prompt: `submit()` adds it locally
 *   via `beginTurn`. `user` events carrying real text occur only in stored
 *   sessions (hydration) and after compaction.
 * - `/compact` shows up as `system`/`compact_boundary` (reduced to the
 *   `compactionSummary` marker) followed by an `isSynthetic` user message
 *   carrying the summary text, which fills the marker.
 * - An interrupt ends with a `result` of subtype `error_during_execution` and
 *   `is_error: true` -- that is the interrupt working, mapped to stopReason
 *   "aborted", not surfaced as an error.
 *
 * Haiku emits thinking blocks headless on every turn, so thinking is a
 * day-one path here, not an option.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { isSyntheticClaudeUserText } from "../../sessions/claude.ts";
import {
	assistantBlockToContent,
	asContentBlock,
	contentBlocksOf,
	emptyUsage,
	mapStopReason,
	toolResultContent,
	usageFromClaude,
} from "./mapping.ts";
import {
	asClaudeEvent,
	isRecord,
	type ClaudeApiMessage,
	type ClaudeAssistantEvent,
	type ClaudeEvent,
	type ClaudeStreamEventBody,
	type ClaudeUserEvent,
} from "./protocol.ts";

/** What the reducer asks the shell to do; `index` feeds the O(1) tail upsert. */
export type ClaudeEffect =
	| { type: "message"; index: number }
	/** The transcript changed wholesale; the server must re-snapshot. */
	| { type: "reset" }
	| { type: "streaming"; isStreaming: boolean }
	| { type: "error"; message: string };

export interface ClaudeReducerOptions {
	/** Injectable clock, so tests are not at the mercy of wall time. */
	now?: () => number;
}

type AssistantBlock = TextContent | ThinkingContent | ToolCall;

interface BlockState {
	content: AssistantBlock;
	/** Accumulated `input_json_delta` text for a streaming tool_use block. */
	partialJson?: string;
}

/** One API message (one `message.id`), merged across its per-block events. */
interface Slot {
	messageIndex: number;
	/** Sparse by wire block index; unknown block types leave holes. */
	blocks: (BlockState | undefined)[];
	/** How many authoritative (`assistant`-event) blocks have landed. */
	authoritativeCount: number;
}

const API = "claude-code";
const PROVIDER = "anthropic";
const DEFAULT_MODEL = "unknown";

export class ClaudeReducer {
	private messages: AgentMessage[] = [];
	private slots = new Map<string, Slot>();
	/** The slot `content_block_*` stream events address. */
	private currentApiId: string | null = null;
	/** tool_use id -> tool name, for `ToolResultMessage.toolName`. */
	private toolNames = new Map<string, string>();
	/** Index of a compaction marker whose summary text has not arrived yet. */
	private pendingCompactionIndex: number | null = null;
	private streaming = false;
	private model: string = DEFAULT_MODEL;
	private readonly now: () => number;

	constructor(options: ClaudeReducerOptions = {}) {
		this.now = options.now ?? (() => Date.now());
	}

	getState(): { messages: AgentMessage[]; isStreaming: boolean } {
		return { messages: this.messages, isStreaming: this.streaming };
	}

	reset(): void {
		this.messages = [];
		this.slots.clear();
		this.currentApiId = null;
		this.toolNames.clear();
		this.pendingCompactionIndex = null;
		this.streaming = false;
	}

	/**
	 * The human's own prompt, added locally at submit time -- the CLI never
	 * echoes it back on the stream (OW-yilabe).
	 */
	beginTurn(
		text: string,
		images?: { mimeType: string; base64: string }[],
	): ClaudeEffect[] {
		const content: UserMessage["content"] = [];
		if (text) content.push({ type: "text", text });
		for (const image of images ?? []) {
			content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
		}
		this.messages.push({ role: "user", content, timestamp: this.now() });
		const effects: ClaudeEffect[] = [{ type: "message", index: this.messages.length - 1 }];
		effects.push(...this.setStreaming(true));
		return effects;
	}

	/**
	 * Cold start (D3): replay a stored session's message lines. The store's
	 * user/assistant records carry the same Anthropic-shaped `message` payload
	 * the live events do, so this is the same code path with no deltas.
	 */
	hydrate(records: Record<string, unknown>[]): ClaudeEffect[] {
		this.reset();
		for (const record of records) {
			const event = asClaudeEvent(record);
			if (event) this.handle(event);
		}
		this.currentApiId = null;
		this.streaming = false;
		return [{ type: "reset" }];
	}

	/** One parsed line from the CLI's stdout. */
	handle(event: ClaudeEvent): ClaudeEffect[] {
		switch (event.type) {
			case "system":
				return this.handleSystem(event);
			case "stream_event":
				return "event" in event && event.event ? this.handleStreamEvent(event.event) : [];
			case "assistant":
				return this.handleAssistant(event as ClaudeAssistantEvent);
			case "user":
				return this.handleUser(event as ClaudeUserEvent);
			case "result":
				return this.handleResult(event);
			default:
				// control_request/control_response are the adapter's business;
				// rate_limit_event and future drift are not transcript state.
				return [];
		}
	}

	// -- system -------------------------------------------------------------

	private handleSystem(event: Extract<ClaudeEvent, { type: "system" }>): ClaudeEffect[] {
		switch (event.subtype) {
			case "init": {
				const model = (event as { model?: unknown }).model;
				if (typeof model === "string" && model) this.model = model;
				// A fresh init mid-stream (after /compact) does not reset the
				// transcript: the session id is unchanged and history stands.
				return [];
			}
			case "status": {
				const status = (event as { status?: unknown }).status;
				// "requesting", "compacting", ... mean a turn phase is running;
				// null means the phase ended (the turn itself ends at `result`).
				return typeof status === "string" && status ? this.setStreaming(true) : [];
			}
			case "compact_boundary": {
				const meta = (event as { compact_metadata?: unknown }).compact_metadata;
				const preTokens =
					isRecord(meta) && typeof meta.pre_tokens === "number" ? meta.pre_tokens : 0;
				this.messages.push({
					role: "compactionSummary",
					summary: "",
					tokensBefore: preTokens,
					timestamp: this.now(),
				});
				this.pendingCompactionIndex = this.messages.length - 1;
				return [{ type: "message", index: this.pendingCompactionIndex }];
			}
			default:
				// thinking_tokens, permission_denied, ... -- not transcript state.
				return [];
		}
	}

	// -- streaming assembly ---------------------------------------------------

	private handleStreamEvent(body: ClaudeStreamEventBody): ClaudeEffect[] {
		switch (body.type) {
			case "message_start": {
				const message = body.message;
				const apiId = typeof message?.id === "string" ? message.id : null;
				if (apiId) {
					this.currentApiId = apiId;
					if (!this.slots.has(apiId)) this.openSlot(apiId, message);
				}
				return this.setStreaming(true);
			}
			case "content_block_start": {
				const slot = this.currentSlot();
				if (!slot || typeof body.index !== "number") return [];
				const block = asContentBlock(body.content_block);
				if (!block) return [];
				const content = assistantBlockToContent(block);
				if (!content) return [];
				if (block.type === "tool_use") this.toolNames.set(block.id, block.name);
				slot.blocks[body.index] = {
					content,
					...(block.type === "tool_use" ? { partialJson: "" } : {}),
				};
				return this.recompose(slot);
			}
			case "content_block_delta": {
				const slot = this.currentSlot();
				const delta = body.delta;
				if (!slot || typeof body.index !== "number" || !delta) return [];
				const state = slot.blocks[body.index];
				switch (delta.type) {
					case "text_delta": {
						if (typeof delta.text !== "string") return [];
						const previous = state?.content.type === "text" ? state.content.text : "";
						slot.blocks[body.index] = { content: { type: "text", text: previous + delta.text } };
						return this.recompose(slot);
					}
					case "thinking_delta": {
						if (typeof delta.thinking !== "string") return [];
						const previous = state?.content.type === "thinking" ? state.content : undefined;
						slot.blocks[body.index] = {
							content: {
								type: "thinking",
								thinking: (previous?.thinking ?? "") + delta.thinking,
								...(previous?.thinkingSignature
									? { thinkingSignature: previous.thinkingSignature }
									: {}),
							},
						};
						return this.recompose(slot);
					}
					case "signature_delta": {
						if (typeof delta.signature !== "string" || state?.content.type !== "thinking") return [];
						slot.blocks[body.index] = {
							content: {
								...state.content,
								thinkingSignature: (state.content.thinkingSignature ?? "") + delta.signature,
							},
						};
						return this.recompose(slot);
					}
					case "input_json_delta": {
						if (typeof delta.partial_json !== "string" || state?.content.type !== "toolCall") {
							return [];
						}
						const partialJson = (state.partialJson ?? "") + delta.partial_json;
						let args = state.content.arguments;
						try {
							const parsed: unknown = JSON.parse(partialJson);
							if (isRecord(parsed)) args = parsed;
						} catch {
							// Incomplete JSON mid-stream; keep the last good parse.
						}
						slot.blocks[body.index] = {
							content: { ...state.content, arguments: args },
							partialJson,
						};
						return this.recompose(slot);
					}
					default:
						return [];
				}
			}
			case "message_delta": {
				const slot = this.currentSlot();
				if (!slot) return [];
				const message = this.messages[slot.messageIndex];
				if (!message || message.role !== "assistant") return [];
				const updated: AssistantMessage = {
					...message,
					...(body.usage ? { usage: usageFromClaude(body.usage) } : {}),
					...(typeof body.delta?.stop_reason === "string"
						? { stopReason: mapStopReason(body.delta.stop_reason) }
						: {}),
				};
				this.messages[slot.messageIndex] = updated;
				return [{ type: "message", index: slot.messageIndex }];
			}
			case "message_stop":
				this.currentApiId = null;
				return [];
			default:
				return [];
		}
	}

	// -- authoritative content ------------------------------------------------

	/**
	 * Per-block authority: the k-th `assistant` event for a message id carries
	 * the completed block at content position k (settled against the fixtures:
	 * blocks complete in index order). Replaces whatever streaming built there.
	 */
	private handleAssistant(event: ClaudeAssistantEvent): ClaudeEffect[] {
		const message = event.message;
		if (!message) return [];
		const apiId = typeof message.id === "string" ? message.id : null;
		if (!apiId) return [];
		let slot = this.slots.get(apiId);
		if (!slot) {
			// No stream events preceded this (hydration replay, or a stream
			// without --include-partial-messages): open the message here.
			slot = this.openSlot(apiId, message, parseTimestamp(event.timestamp));
		}
		for (const block of contentBlocksOf(message.content)) {
			const position = slot.authoritativeCount++;
			if (block.type === "tool_use") this.toolNames.set(block.id, block.name);
			const content = assistantBlockToContent(block);
			if (content) slot.blocks[position] = { content };
		}
		const current = this.messages[slot.messageIndex];
		if (current?.role === "assistant" && message.usage) {
			this.messages[slot.messageIndex] = { ...current, usage: usageFromClaude(message.usage) };
		}
		return this.recompose(slot);
	}

	// -- user events ----------------------------------------------------------

	private handleUser(event: ClaudeUserEvent): ClaudeEffect[] {
		const blocks = contentBlocksOf(event.message?.content);
		const effects: ClaudeEffect[] = [];
		const timestamp = parseTimestamp(event.timestamp) ?? this.now();

		const texts: string[] = [];
		for (const block of blocks) {
			if (block.type === "tool_result") {
				const details =
					(event as { tool_use_result?: unknown }).tool_use_result ??
					// The store file spells the same field toolUseResult.
					(event as { toolUseResult?: unknown }).toolUseResult;
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: block.tool_use_id,
					toolName: this.toolNames.get(block.tool_use_id) ?? "",
					content: toolResultContent(block.content),
					isError: block.is_error === true,
					timestamp,
					...(details !== undefined ? { details } : {}),
				};
				this.messages.push(result);
				effects.push({ type: "message", index: this.messages.length - 1 });
			} else if (block.type === "text") {
				texts.push(block.text);
			}
		}

		if (texts.length === 0) return effects;
		const joined = texts.join("\n").trim();

		// The post-compaction summary arrives as an isSynthetic user message; it
		// belongs on the marker, not in the transcript as something a human said.
		if (event.isSynthetic === true) {
			if (this.pendingCompactionIndex !== null && joined) {
				const index = this.pendingCompactionIndex;
				const marker = this.messages[index];
				if (marker?.role === "compactionSummary") {
					this.messages[index] = { ...marker, summary: joined };
					effects.push({ type: "message", index });
				}
				this.pendingCompactionIndex = null;
			}
			return effects;
		}
		// Replayed echoes (`<local-command-stdout>...` after /compact) and
		// harness-injected wrapper lines are not human turns.
		if (event.isReplay === true) return effects;
		const kept = texts.filter((text) => text.trim().length > 0 && !isSyntheticClaudeUserText(text));
		if (kept.length === 0) return effects;

		this.messages.push({
			role: "user",
			content: kept.map((text) => ({ type: "text", text })),
			timestamp,
		});
		effects.push({ type: "message", index: this.messages.length - 1 });
		return effects;
	}

	// -- turn end -------------------------------------------------------------

	private handleResult(event: Extract<ClaudeEvent, { type: "result" }>): ClaudeEffect[] {
		const effects: ClaudeEffect[] = [];
		// An interrupt's result is `error_during_execution` + `is_error: true`
		// (and exit 1 on a lone -p turn): that is the abort WORKING. Mark the
		// message it cut short rather than reporting a failure.
		if (event.subtype === "error_during_execution") {
			for (let i = this.messages.length - 1; i >= 0; i--) {
				const message = this.messages[i];
				if (message?.role !== "assistant") continue;
				this.messages[i] = { ...message, stopReason: "aborted" };
				effects.push({ type: "message", index: i });
				break;
			}
		} else if (event.is_error === true) {
			const detail = typeof event.result === "string" && event.result ? `: ${event.result}` : "";
			effects.push({
				type: "error",
				message: `claude turn failed (${event.subtype ?? "unknown"})${detail}`,
			});
		}
		this.currentApiId = null;
		this.slots.clear();
		effects.push(...this.setStreaming(false));
		return effects;
	}

	// -- internals ------------------------------------------------------------

	private openSlot(
		apiId: string,
		message: ClaudeApiMessage | undefined,
		timestamp?: number,
	): Slot {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [],
			api: API,
			provider: PROVIDER,
			model:
				typeof message?.model === "string" && message.model ? message.model : this.model,
			usage: message?.usage ? usageFromClaude(message.usage) : emptyUsage(),
			stopReason: "stop",
			timestamp: timestamp ?? this.now(),
		};
		this.messages.push(assistant);
		const slot: Slot = {
			messageIndex: this.messages.length - 1,
			blocks: [],
			authoritativeCount: 0,
		};
		this.slots.set(apiId, slot);
		return slot;
	}

	private currentSlot(): Slot | undefined {
		return this.currentApiId ? this.slots.get(this.currentApiId) : undefined;
	}

	private recompose(slot: Slot): ClaudeEffect[] {
		const message = this.messages[slot.messageIndex];
		if (!message || message.role !== "assistant") return [];
		const content = slot.blocks
			.filter((block): block is BlockState => block !== undefined)
			.map((block) => block.content);
		this.messages[slot.messageIndex] = { ...message, content };
		return [{ type: "message", index: slot.messageIndex }];
	}

	private setStreaming(isStreaming: boolean): ClaudeEffect[] {
		if (this.streaming === isStreaming) return [];
		this.streaming = isStreaming;
		return [{ type: "streaming", isStreaming }];
	}
}

function parseTimestamp(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}
