/**
 * The Claude Code stream-json wire surface, as this adapter consumes it.
 *
 * There are no generated bindings to lean on (unlike Codex): these shapes are
 * transcribed from live captures of `claude 2.1.238` -- the fixtures under
 * `resources/fixtures/claude/` and the OW-yilabe/OW-mayuza sections of
 * `docs/MANUAL_TESTING.md`. Claude Code versions weekly, so every consumer of
 * these types stays defensive: an unknown event type or content block is
 * ignored, never thrown on.
 *
 * Both directions are NDJSON over the child's stdio. Client -> CLI lines are
 * user messages (`buildUserMessageLine`) and control requests
 * (`buildControlRequestLine`); CLI -> client lines are the `ClaudeEvent`
 * union below.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Anthropic message payloads (shared by `assistant`/`user` events, the
// `stream_event` envelope, and the store file's message lines)
// ---------------------------------------------------------------------------

export interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface ClaudeTextBlock {
	type: "text";
	text: string;
}

export interface ClaudeThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

export interface ClaudeToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input?: unknown;
}

export interface ClaudeToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content?: string | unknown[];
	is_error?: boolean;
}

export type ClaudeContentBlock =
	| ClaudeTextBlock
	| ClaudeThinkingBlock
	| ClaudeToolUseBlock
	| ClaudeToolResultBlock;

export interface ClaudeApiMessage {
	/** API message id (`msg_...`). Assistant events merge on this (OW-yilabe). */
	id?: string;
	role?: string;
	model?: string;
	content?: string | unknown[];
	usage?: ClaudeUsage;
	stop_reason?: string | null;
}

// ---------------------------------------------------------------------------
// Stream events (`--include-partial-messages`)
// ---------------------------------------------------------------------------

export interface ClaudeStreamDelta {
	type?: string;
	text?: string;
	thinking?: string;
	signature?: string;
	partial_json?: string;
	stop_reason?: string | null;
}

export type ClaudeStreamEventBody =
	| { type: "message_start"; message?: ClaudeApiMessage }
	| { type: "content_block_start"; index?: number; content_block?: unknown }
	| { type: "content_block_delta"; index?: number; delta?: ClaudeStreamDelta }
	| { type: "content_block_stop"; index?: number }
	| { type: "message_delta"; delta?: ClaudeStreamDelta; usage?: ClaudeUsage }
	| { type: "message_stop" };

// ---------------------------------------------------------------------------
// Top-level stdout events
// ---------------------------------------------------------------------------

export interface ClaudeInitEvent {
	type: "system";
	subtype: "init";
	session_id?: string;
	model?: string;
	cwd?: string;
	permissionMode?: string;
}

export interface ClaudeStatusEvent {
	type: "system";
	subtype: "status";
	/** "requesting" | "compacting" | ... | null (turn phase ended). */
	status?: string | null;
}

export interface ClaudeCompactBoundaryEvent {
	type: "system";
	subtype: "compact_boundary";
	compact_metadata?: {
		trigger?: string;
		pre_tokens?: number;
		post_tokens?: number;
	};
}

export interface ClaudeAssistantEvent {
	type: "assistant";
	message?: ClaudeApiMessage;
	timestamp?: string;
}

export interface ClaudeUserEvent {
	type: "user";
	message?: { role?: string; content?: string | unknown[] };
	/** Set on replayed lines (e.g. the `<local-command-stdout>` echo after /compact). */
	isReplay?: boolean;
	/** Set on harness-fabricated lines (the post-compaction summary user message). */
	isSynthetic?: boolean;
	/** Structured result Claude Code attaches beside a tool_result block. */
	tool_use_result?: unknown;
	timestamp?: string;
}

export interface ClaudeResultEvent {
	type: "result";
	/** "success", or e.g. "error_during_execution" (which an interrupt produces). */
	subtype?: string;
	is_error?: boolean;
	num_turns?: number;
	result?: string;
}

export interface ClaudeControlResponseEvent {
	type: "control_response";
	response?: {
		subtype?: "success" | "error";
		request_id?: string;
		response?: unknown;
		error?: string;
	};
}

export interface ClaudeControlRequestEvent {
	type: "control_request";
	request_id?: string;
	request?: { subtype?: string } & Record<string, unknown>;
}

export type ClaudeEvent =
	| ClaudeInitEvent
	| ClaudeStatusEvent
	| ClaudeCompactBoundaryEvent
	| { type: "system"; subtype?: string }
	| ClaudeAssistantEvent
	| ClaudeUserEvent
	| { type: "stream_event"; event?: ClaudeStreamEventBody }
	| ClaudeResultEvent
	| ClaudeControlResponseEvent
	| ClaudeControlRequestEvent;

/**
 * One parsed stdout line as a `ClaudeEvent`, or null for anything that is not
 * an object with a string `type`. The cast is the one seam where the wire's
 * openness meets these types (the same stance codex's test-support takes):
 * event types this union does not name (`rate_limit_event`, future drift)
 * fall through every consumer's `switch` into its ignore branch.
 */
export function asClaudeEvent(value: unknown): ClaudeEvent | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	return value as unknown as ClaudeEvent;
}

export function parseClaudeEventLine(line: string): ClaudeEvent | null {
	if (!line.trim()) return null;
	try {
		return asClaudeEvent(JSON.parse(line));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Client -> CLI lines
// ---------------------------------------------------------------------------

export type ClaudeUserContent =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export function buildUserMessageLine(content: ClaudeUserContent[]): Record<string, unknown> {
	return { type: "user", message: { role: "user", content } };
}

export function buildControlRequestLine(
	requestId: string,
	request: { subtype: string } & Record<string, unknown>,
): Record<string, unknown> {
	return { type: "control_request", request_id: requestId, request };
}

/** One entry of the `initialize` control response's `models` array. */
export interface ClaudeModelDescriptor {
	value?: string;
	resolvedModel?: string;
	displayName?: string;
	description?: string;
}
