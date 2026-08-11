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
 * included -- not the full RPC surface (thinking level, compaction knobs,
 * bash-as-a-command, session naming, etc. are all real commands we simply
 * never send).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ToolCall } from "@earendil-works/pi-ai";

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
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
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
			command: "get_state";
			success: true;
			data: { model: Model<any> | null; isStreaming: boolean; sessionFile?: string };
	  }
	| { id?: string; type: "response"; command: "set_model"; success: true; data: Model<any> }
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
	| { id?: string; type: "response"; command: string; success: false; error: string };

/** Narrow `PiResponse` to the one matching a given command's `type`. */
export type PiResponseFor<C extends PiCommandType> = Extract<PiResponse, { command: C }>;

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
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: unknown;
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
// ---------------------------------------------------------------------------

export function modelToInfo(model: Model<any>): { id: string; label: string } {
	return { id: `${model.provider}/${model.id}`, label: model.name };
}

export function splitModelRef(modelRef: string): { provider: string; modelId: string } {
	const slash = modelRef.indexOf("/");
	if (slash === -1) {
		throw new Error(`Pi model ref must be "provider/modelId", got: ${JSON.stringify(modelRef)}`);
	}
	return { provider: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}
