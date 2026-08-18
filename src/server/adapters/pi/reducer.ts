/**
 * Pure Pi event reducer: RPC notification lines in, `AgentMessage[]` +
 * `isStreaming` out (plus the D2a request/reply side channel).
 *
 * This is deliberately free of any subprocess/stdio concern -- see
 * `process.ts` for that -- so it can be driven directly by a test over the
 * recorded fixtures in `resources/fixtures/pi/`.
 *
 * Design (DESIGN.md, "The backend adapter contract"):
 *   - `message_start`/`message_end` payloads already ARE `AgentMessage`s.
 *   - `message_update` deltas assemble the live text of the last message by
 *     `contentIndex`.
 *   - `message_end` is authoritative: it replaces whatever the deltas built,
 *     rather than being merged with it. This matters because `message_end`
 *     carries fields (usage, stopReason, timestamps, thinking signatures)
 *     that streaming deltas never do.
 *   - `agent_settled`, not `agent_end`, is the real terminal signal (an
 *     `agent_end` can be followed by retry/compaction/queued continuations).
 *
 * `reducePiNotification` returns the *same* state object reference when a
 * notification has no observable effect (e.g. `turn_start`,
 * `tool_execution_update`) so a caller can cheaply detect "did anything
 * change" with `result.state !== previousState` rather than deep-comparing.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRequest } from "../../../shared/protocol.ts";
import { PI_DIALOG_METHODS, type PiCommand, type PiDialogMethod, type PiNotification } from "./protocol.ts";

export interface PiReducerState {
	readonly messages: AgentMessage[];
	readonly isStreaming: boolean;
	/** requestId -> dialog method, so `reply()` knows how to shape the response. */
	readonly pendingUiRequests: Readonly<Record<string, PiDialogMethod>>;
}

export interface PiReduceResult {
	state: PiReducerState;
	/**
	 * Index of the single message that was added or changed, when known --
	 * mirrors `BackendAdapter.onUpdate`'s `changedIndex` (D3 tail-upsert).
	 * Undefined when `state` didn't change, OR when it changed in a way that
	 * isn't about one message (e.g. `isStreaming` flipping), in which case a
	 * caller should treat it as "state changed, no single index" rather than
	 * "nothing changed" -- compare `state` by reference, not this field, to
	 * decide whether to notify.
	 */
	changedIndex?: number;
	/** Present when this notification is a request the human must answer (D2a). */
	request?: Pick<AgentRequest, "requestId" | "kind" | "payload">;
	/** Present when this notification signals a failure the transcript itself won't show. */
	error?: string;
}

export function createInitialPiState(): PiReducerState {
	return { messages: [], isStreaming: false, pendingUiRequests: {} };
}

export function reducePiNotification(state: PiReducerState, event: PiNotification): PiReduceResult {
	switch (event.type) {
		case "agent_start":
			return { state: { ...state, isStreaming: true } };

		case "agent_settled":
			return { state: { ...state, isStreaming: false } };

		case "message_start": {
			const messages = [...state.messages, event.message];
			return { state: { ...state, messages }, changedIndex: messages.length - 1 };
		}

		case "message_end": {
			// Authoritative: replace the message at the same slot `message_start`
			// created, not merge. Defensively append instead if we somehow never
			// saw the matching `message_start` (should not happen per rpc.md, but
			// D9's "never throw on something you don't recognise" spirit applies).
			const index = state.messages.length - 1;
			if (index < 0) {
				const messages = [event.message];
				return { state: { ...state, messages }, changedIndex: 0 };
			}
			const messages = state.messages.slice();
			messages[index] = event.message;
			return { state: { ...state, messages }, changedIndex: index };
		}

		case "message_update":
			return reduceAssistantDelta(state, event.assistantMessageEvent);

		case "extension_ui_request": {
			const { type: _type, id, method, ...payload } = event;
			const isDialog = (PI_DIALOG_METHODS as readonly string[]).includes(method);
			const pendingUiRequests = isDialog
				? { ...state.pendingUiRequests, [id]: method as PiDialogMethod }
				: state.pendingUiRequests;
			const nextState = isDialog ? { ...state, pendingUiRequests } : state;
			// Only dialog methods (select/confirm/input/editor) actually block
			// on a human -- that's the contract `BackendAdapter.onRequest` documents
			// ("Fires when the agent asks the human something and blocks"). The
			// fire-and-forget methods (notify/setStatus/setWidget/setTitle/
			// set_editor_text) are presentation hints with no reply and no home in
			// the frozen `ServerEvent` union; see this workstream's report for why
			// they're dropped here rather than forwarded.
			if (!isDialog) return { state: nextState };
			return { state: nextState, request: { requestId: id, kind: method, payload } };
		}

		case "extension_error":
			return { state, error: `Extension error (${event.extensionPath}, ${event.event}): ${event.error}` };

		case "auto_retry_end":
			if (!event.success) {
				return { state, error: event.finalError ?? "Pi retry failed after transient errors" };
			}
			return { state };

		case "compaction_end":
			if (!event.aborted && event.errorMessage) {
				return { state, error: event.errorMessage };
			}
			// A successful compaction reports its summary and the token count it
			// shrank (OW-72). Pi does NOT push this through message_start/end --
			// verified against resources/fixtures/pi/compact.jsonl, where the only
			// events after compaction_start are compaction_end and the command
			// response -- so the transcript would show nothing unless we append a
			// message here. Mirror the `CompactionSummaryMessage` shape
			// pi-agent-core declaration-merges into AgentMessage; `Message.svelte`
			// draws the marker plus this summary text.
			if (event.result) {
				const summary: AgentMessage = {
					role: "compactionSummary",
					summary: event.result.summary,
					tokensBefore: event.result.tokensBefore,
					timestamp: Date.now(),
				};
				const messages = [...state.messages, summary];
				return { state: { ...state, messages }, changedIndex: messages.length - 1 };
			}
			return { state };

		// No structural effect on AgentMessage[] or isStreaming: turn boundaries
		// are redundant with message_start/message_end (every message in
		// turn_end already arrived via its own message_start/message_end pair);
		// tool_execution_*/bash_execution_update are live-progress duplicates of
		// what message_end's toolResult message already carries authoritatively;
		// queue_update/compaction_start/auto_retry_start/summarization_* are
		// session bookkeeping outside the AgentMessage/isStreaming contract.
		default:
			return { state };
	}
}

function reduceAssistantDelta(
	state: PiReducerState,
	delta: Extract<PiNotification, { type: "message_update" }>["assistantMessageEvent"],
): PiReduceResult {
	const index = state.messages.length - 1;
	const current = state.messages[index];
	if (!current || current.role !== "assistant") {
		// A delta with no open assistant message (shouldn't happen per rpc.md's
		// documented sequencing) -- ignore rather than throw.
		return { state };
	}

	const content = current.content.slice();
	switch (delta.type) {
		case "text_start":
			content[delta.contentIndex] = { type: "text", text: "" };
			break;
		case "text_delta": {
			const block = content[delta.contentIndex];
			const prevText = block?.type === "text" ? block.text : "";
			content[delta.contentIndex] = { type: "text", text: prevText + delta.delta };
			break;
		}
		case "text_end":
			content[delta.contentIndex] = { type: "text", text: delta.content };
			break;
		case "thinking_start":
			content[delta.contentIndex] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta": {
			const block = content[delta.contentIndex];
			const prevThinking = block?.type === "thinking" ? block.thinking : "";
			content[delta.contentIndex] = { type: "thinking", thinking: prevThinking + delta.delta };
			break;
		}
		case "thinking_end":
			content[delta.contentIndex] = { type: "thinking", thinking: delta.content };
			break;
		case "toolcall_start":
			content[delta.contentIndex] = { type: "toolCall", id: "", name: "", arguments: {} };
			break;
		case "toolcall_delta":
			// Raw JSON-argument text accumulates provider-side and is not valid
			// JSON until `toolcall_end` supplies the parsed, complete `ToolCall`.
			// There's no structurally-typed home for a partial parse, and
			// `toolcall_end` is imminent, so this is a no-op (same state
			// reference) rather than churn callers must filter out.
			return { state };
		case "toolcall_end":
			content[delta.contentIndex] = delta.toolCall;
			break;
	}

	const updated: AssistantMessage = { ...current, content };
	const messages = state.messages.slice();
	messages[index] = updated;
	return { state: { ...state, messages }, changedIndex: index };
}

// ---------------------------------------------------------------------------
// Extension UI replies (D2a)
// ---------------------------------------------------------------------------

/**
 * Build the `extension_ui_response` command for a pending dialog request.
 * `response === null` (or `undefined`) declines/cancels, per
 * `BackendAdapter.reply`'s "null declines".
 */
export function buildUiReplyCommand(
	method: PiDialogMethod,
	requestId: string,
	response: unknown,
): Extract<PiCommand, { type: "extension_ui_response" }> {
	if (response === null || response === undefined) {
		return { type: "extension_ui_response", id: requestId, cancelled: true };
	}
	if (method === "confirm") {
		return { type: "extension_ui_response", id: requestId, confirmed: Boolean(response) };
	}
	// select / input / editor all reply with a string value.
	return { type: "extension_ui_response", id: requestId, value: String(response) };
}
