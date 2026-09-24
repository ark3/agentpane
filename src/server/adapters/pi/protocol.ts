/**
 * Pi RPC wire protocol (`pi --mode rpc`), hand-written.
 *
 * This is NOT imported from `@earendil-works/pi-coding-agent` on purpose:
 * that package is not a project dependency (only `pi-agent-core` and
 * `pi-ai` are, and only for types -- D10). It only exists on this machine
 * as a global bun install used as reference documentation. The shapes below
 * are transcribed from `pi-coding-agent/docs/rpc.md` and cross-checked
 * against the installed CLI's `dist/modes/rpc/rpc-types.d.ts`.
 *
 * Only the commands/events/responses this adapter actually speaks are
 * included -- not the full RPC surface (bash-as-a-command, session naming,
 * cycling, etc. are all real commands we simply never send). The
 * manual-compaction `compact` command IS spoken (OW-72), transcribed from
 * rpc.md's "Compaction" section, and so is `set_thinking_level` with the
 * `thinking_level_changed` event (OW-ruzuhu), from `rpc-commands.md`'s
 * "Thinking" and `json.md` as of `pi 0.87.1`.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ToolCall } from "@earendil-works/pi-ai";
import { BackendRefusedError } from "../types.ts";

// ---------------------------------------------------------------------------
// Commands (stdin)
// ---------------------------------------------------------------------------

export type PiCommand =
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "abort" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	// `level` is one of `off|minimal|low|medium|high|xhigh|max`. As of 0.87.1 Pi
	// answers success for a level the model lacks and clamps it -- to the next
	// level up the model has, else down -- so `medium` on a model without it
	// ran at `high` (docs/MANUAL_TESTING.md, OW-ruzuhu).
	| { id?: string; type: "set_thinking_level"; level: string }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type PiCommandType = PiCommand["type"];

// ---------------------------------------------------------------------------
// Responses (stdout, `type: "response"`)
// ---------------------------------------------------------------------------

export type PiResponse =
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| {
			id?: string;
			type: "response";
			command: "compact";
			success: true;
			// rpc.md "Compaction": the summary plus the token accounting the
			// compaction shrank (same shape `compaction_end` carries in `result`).
			data: PiCompactionResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_state";
			success: true;
			data: { model: Model<any> | null; thinkingLevel?: string; isStreaming: boolean; sessionFile?: string };
	  }
	| { id?: string; type: "response"; command: "set_model"; success: true; data: Model<any> }
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "fork";
			success: true;
			data: { text: string; cancelled: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: { entryId: string; text: string }[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_messages";
			success: true;
			data: { messages: AgentMessage[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			// Every entry in the session file, abandoned branches included, and the
			// active branch's tip, as `rpc-mode.js` answers it in 0.87.1.
			data: { entries: PiSessionEntry[]; leafId: string | null };
	  }
	| { id?: string; type: "response"; command: string; success: false; error: string };

/**
 * One entry of a Pi session file, as `get_entries` returns it: `SessionEntryBase`
 * from `core/session-manager.d.ts` in 0.87.1, plus the fields of the two kinds
 * this adapter reads. The other kinds (`model_change`, `compaction`,
 * `branch_summary`, `custom`, ...) carry only the base fields as far as it is
 * concerned.
 */
export interface PiSessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	/** ISO 8601, stamped when the entry was appended. */
	timestamp: string;
	/** On `type: "message"`. */
	message?: AgentMessage;
	/** On `type: "thinking_level_change"`: the level in force from here on. */
	thinkingLevel?: string;
}

/** Narrow `PiResponse` to the one matching a given command's `type`. */
export type PiResponseFor<C extends PiCommandType> = Extract<PiResponse, { command: C }>;

/**
 * The payload a successful compaction reports (rpc.md "Compaction"): the
 * summary that replaces the folded history, and the token accounting it
 * shrank. Rides both the `compact` command response's `data` and the
 * `compaction_end` notification's `result`.
 */
export interface PiCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter: number;
	usage?: unknown;
	details?: unknown;
}

// ---------------------------------------------------------------------------
// message_update deltas
//
// NOTE: this is deliberately NOT `AssistantMessageEvent` from `pi-ai` --
// rpc.md is explicit that RPC mode strips the cumulative `partial` field
// those carry ("message_update intentionally omits ... `assistantMessageEvent.partial`").
// A client that assumed the pi-ai shape would get a type that lies about
// what's on the wire.
// ---------------------------------------------------------------------------

export type PiAssistantMessageEvent =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };

// ---------------------------------------------------------------------------
// Extension UI sub-protocol
// ---------------------------------------------------------------------------

/** The four dialog methods that block and expect an `extension_ui_response`. */
export const PI_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type PiDialogMethod = (typeof PI_DIALOG_METHODS)[number];

/** Fire-and-forget methods: emitted but no response is expected or read. */
export type PiFireAndForgetMethod = "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";

export type PiExtensionUiRequestEvent =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ---------------------------------------------------------------------------
// Notification events (stdout, everything that is not `type: "response"`)
// ---------------------------------------------------------------------------

export type PiNotification =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
	| { type: "agent_settled" }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; assistantMessageEvent: PiAssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	// Emitted whenever the level actually changes -- by `set_thinking_level`,
	// and by `set_model` re-applying the settings default (OW-ruzuhu) -- before
	// the command's own response, as of 0.87.1.
	| { type: "thinking_level_changed"; level: string }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			// `result` is the same shape the `compact` command response carries, or
			// null when the compaction aborted or failed (rpc.md "compaction_end").
			result: PiCompactionResult | null;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "summarization_retry_attempt_start"; source: "compaction" | "branchSummary"; reason?: string }
	| { type: "summarization_retry_finished" }
	| { type: "extension_error"; extensionPath: string; event: string; error: string }
	| PiExtensionUiRequestEvent;

/** Every line Pi can write to stdout in RPC mode. */
export type PiOutputLine = PiResponse | PiNotification;

// ---------------------------------------------------------------------------
// Model refs
//
// `ModelInfo` (frozen, src/shared/protocol.ts) is `{ id, label }` with no
// separate provider field, but Pi's `set_model` command needs `provider` and
// `modelId` split. We bridge this the same way Pi's own `--model` CLI flag
// documents ("supports `provider/id`"): `ModelInfo.id` is `provider/modelId`.
//
// This is the one statement of which model strings each path takes; the spawn
// flag's docblock in `spawn.ts` and `PiAdapter.setModel` cite it.
//
//  - `set_model` takes `provider/modelId` and nothing else: split at the first
//    slash below, then matched against the catalogue verbatim (rpc-mode.js,
//    read at the source in `pi 0.87.1`).
//  - The spawn flag `--model` takes more: "Model pattern or ID (supports
//    "provider/id" and optional ":<thinking>")", Pi's own help text as of
//    `pi 0.87.1`. So `provider/modelId:thinkingLevel`, the form AGENTS.md's
//    model pin is written in, starts a session and sets its level too, and
//    sets it again at every fork in that process (OW-dojebo), which is why
//    `PiAdapter.fork` re-sends a chosen level.
//
// That suffix is the gap: sent to `set_model` it answered "Model not found"
// (`pi 0.85.1`, 2026-09-16, OW-pizaki). Nothing strips it, because the level
// is the effort's to set and a colon is no delimiter -- as of `pi 0.87.1` the
// catalogue lists `openrouter/anthropic/claude-fable-5:batch`. So the string
// goes to Pi whole, and only Pi's refusal of one ending in a level says why.
// ---------------------------------------------------------------------------

export function modelToInfo(model: Model<any>): { id: string; label: string } {
	return { id: `${model.provider}/${model.id}`, label: model.name };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The thinking levels a client may choose among for `model`, in Pi's order:
 * `pi-ai`'s `getSupportedThinkingLevels`, transcribed because D10 keeps that
 * package types-only (read at the source in `pi-ai` as installed with
 * `pi 0.87.1`). A `null` in `thinkingLevelMap` removes a level, and `xhigh`
 * and `max` exist only where the map names them.
 *
 * Derived from the catalogue entry, not asked of Pi, because
 * `get_available_thinking_levels` answers for the current model only and
 * `ModelInfo.efforts` is per model; the live run found the two agree for the
 * models it read (docs/MANUAL_TESTING.md, OW-ruzuhu). One departure: Pi
 * answers `["off"]` for a model that does not reason, and this answers
 * nothing, since there is no choice to offer.
 */
export function thinkingLevels(model: Model<any>): string[] {
	if (!model.reasoning) return [];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * The level Pi runs `model` at when asked for `level`: `pi-ai`'s
 * `clampThinkingLevel`, transcribed for the same reason as `thinkingLevels`
 * and read at the same source. A level the model lacks moves up to the
 * nearest one it has, else down; a model that does not reason runs at `off`.
 */
export function clampThinkingLevel(model: Model<any>, level: string): string {
	const available: string[] = model.reasoning ? thinkingLevels(model) : ["off"];
	if (available.includes(level)) return level;
	const requested = (THINKING_LEVELS as readonly string[]).indexOf(level);
	if (requested === -1) return available[0] ?? "off";
	const up = THINKING_LEVELS.slice(requested).find((candidate) => available.includes(candidate));
	const down = THINKING_LEVELS.slice(0, requested).findLast((candidate) => available.includes(candidate));
	return up ?? down ?? available[0] ?? "off";
}

export function splitModelRef(modelRef: string): { provider: string; modelId: string } {
	const slash = modelRef.indexOf("/");
	if (slash === -1) {
		throw new BackendRefusedError(`Pi model ref must be "provider/modelId", got: ${JSON.stringify(modelRef)}`);
	}
	return { provider: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}

/** Pi's refusal of `modelRef` for `set_model`, saying so when a thinking-level suffix is the likely reason. */
export function modelRefusal(modelRef: string, piError: string): string {
	const level = THINKING_LEVELS.find((candidate) => modelRef.endsWith(`:${candidate}`));
	if (!level) return piError;
	return (
		`${piError}. A model here is "provider/modelId"; the ":${level}" suffix is only for Pi's --model flag. ` +
		`Choose the model without it and set "${level}" as the effort.`
	);
}
