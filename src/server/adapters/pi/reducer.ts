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
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentRequest, AssistantTurn, PaneMessage } from "../../../shared/protocol.ts";
import {
	clampThinkingLevel,
	PI_DIALOG_METHODS,
	type PiCommand,
	type PiDialogMethod,
	type PiNotification,
	type PiSessionEntry,
} from "./protocol.ts";

export interface PiReducerState {
	readonly messages: AgentMessage[];
	readonly isStreaming: boolean;
	readonly compaction: "requesting" | "running" | null;
	/**
	 * The thinking level named on each assistant message as it arrives, the
	 * `AssistantTurn.effort` the footer shows. Pi's messages carry none, so
	 * `process.ts` keeps this current from what Pi reports (OW-ruzuhu); null
	 * names nothing, as for a model that does not reason.
	 */
	readonly effort: string | null;
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
	return { messages: [], isStreaming: false, compaction: null, effort: null, pendingUiRequests: {} };
}

export function reducePiNotification(state: PiReducerState, event: PiNotification): PiReduceResult {
	switch (event.type) {
		case "agent_start":
			return { state: { ...state, isStreaming: true } };

		case "agent_settled":
			return { state: { ...state, isStreaming: false } };

		case "message_start": {
			const messages = [...state.messages, withEffort(event.message, state.effort)];
			return { state: { ...state, messages }, changedIndex: messages.length - 1 };
		}

		case "message_end": {
			// Authoritative: replace the message at the same slot `message_start`
			// created, not merge. Defensively append instead if we somehow never
			// saw the matching `message_start` (should not happen per rpc.md, but
			// D9's "never throw on something you don't recognise" spirit applies).
			const index = state.messages.length - 1;
			if (index < 0) {
				const messages = [withEffort(event.message, state.effort)];
				return { state: { ...state, messages }, changedIndex: 0 };
			}
			// The level the turn started at, not the one in force as it ends: a
			// `thinking_level_changed` can land mid-stream (OW-ruzuhu).
			const replaced = state.messages[index] as PaneMessage | undefined;
			const started = replaced?.role === "assistant" ? replaced.effort : undefined;
			const messages = state.messages.slice();
			messages[index] = withEffort(event.message, started ?? state.effort);
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
			// Only dialog methods (select/confirm/input/editor) block Pi until
			// answered -- that's the contract `BackendAdapter.onRequest` documents
			// ("Fires when the agent asks the human something and blocks"). Until a
			// human can answer one (OW-bijera), the adapter cancels each as soon as
			// it has published it rather than holding it (D2a, OW-yosuzo). The
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

		case "compaction_start":
			return { state: { ...state, compaction: "running" } };

		case "compaction_end": {
			const terminalState: PiReducerState = state.compaction === null ? state : { ...state, compaction: null };
			if (!event.aborted && event.errorMessage) {
				return { state: terminalState, error: event.errorMessage };
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
				const messages = [...terminalState.messages, summary];
				return { state: { ...terminalState, messages }, changedIndex: messages.length - 1 };
			}
			return { state: terminalState };
		}

		// No structural effect on AgentMessage[] or isStreaming: turn boundaries
		// are redundant with message_start/message_end (every message in
		// turn_end already arrived via its own message_start/message_end pair);
		// tool_execution_*/bash_execution_update are live-progress duplicates of
		// what message_end's toolResult message already carries authoritatively;
		// queue_update/auto_retry_start/summarization_* are
		// session bookkeeping outside the AgentMessage/isStreaming contract.
		default:
			return { state };
	}
}

/**
 * Name the level on an assistant message, as Codex's reducer names its effort.
 * Deltas keep it by spreading the message they extend, so only the two events
 * that bring a whole message need this, and `message_end` passes on the level
 * its slot started with.
 */
function withEffort(message: AgentMessage, effort: string | null): AgentMessage {
	if (effort === null || message.role !== "assistant") return message;
	const turn: AssistantTurn = { ...message, effort };
	return turn;
}

/**
 * Name on each loaded assistant message the level it ran at, read from the
 * session file's entries (OW-helumu): `get_messages` carries none, and the level
 * in force now is not the one an earlier turn ran at (D23, read per turn).
 *
 * The levels come from the active branch, walked from `leafId` by `parentId`,
 * since `get_entries` also returns abandoned branches. Each assistant message
 * gets the last `thinking_level_change` on that branch appended before the
 * message's own `timestamp`, which Pi's provider stamps as the reply begins. So
 * a change made while a turn streamed, which Pi appends ahead of that turn's
 * entry, is not read as the turn's: the same level `message_start` would have
 * named live. A tie to the millisecond names nothing.
 *
 * Messages are matched to entries by that `timestamp`, not by position:
 * `get_messages` is Pi's context, where a compaction replaces the folded
 * history with a summary and a context edit can drop a message, so positions
 * need not line up with the branch. A timestamp the branch holds twice, or not
 * at all, leaves the message unlabelled rather than guessing.
 *
 * The recorded level is clamped to the turn's model, found in `catalogue`,
 * because a resume puts a level in force without recording it: Pi restores the
 * last recorded level and clamps it to the model it resolved, and appends an
 * entry only for a session that has none. As of `pi 0.87.1` a resume whose
 * clamp changed the level, and one given `--model <ref>:<level>` or
 * `--thinking`, each appended nothing (docs/MANUAL_TESTING.md, OW-lehita).
 * The clamp recovers the first, since Pi clamps the same way each time; a
 * level Pi records is already clamped, so for it the clamp changes nothing.
 * Both hold only while the model's catalogue entry is the one the turn ran
 * under: the pinned model's levels changed between `pi 0.85.1` and `0.87.1`
 * (docs/MANUAL_TESTING.md, OW-ruzuhu), so a turn run at a level since dropped
 * is named at the level its model clamps it to now. A turn whose model has
 * left the catalogue keeps the level recorded. The
 * override is recoverable nowhere: the level named on the command line is on
 * no record, so a turn driven under one, from the `pi` CLI (agentpane's
 * resume spawn carries no `--model`, OW-pubulu), reloads with the level
 * recorded before it.
 *
 * Live stamping names nothing for a model that does not reason, and Pi clamps
 * such a model to `off` (`clampThinkingLevel` in `pi-ai`, read at the source in
 * 0.87.1), so a clamped level other than `off` means the model reasoned. At
 * `off` that is only known for the model `get_state` names now (`current`), so
 * an `off` turn on any other model is left unlabelled.
 */
export function withLoadedEfforts(
	messages: AgentMessage[],
	entries: PiSessionEntry[],
	leafId: string | null,
	current: { model: string | null; reasoning: boolean },
	catalogue: Model<any>[],
): AgentMessage[] {
	const models = new Map(catalogue.map((model) => [`${model.provider}/${model.id}`, model]));
	const changes: { at: number; level: string }[] = [];
	const levels = new Map<number, string | null>();
	for (const entry of activeBranch(entries, leafId)) {
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			changes.push({ at: Date.parse(entry.timestamp), level: entry.thinkingLevel });
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role !== "assistant" || typeof message.timestamp !== "number") continue;
		const started = message.timestamp;
		const before = changes.findLast((change) => change.at <= started);
		const ref = `${message.provider}/${message.model}`;
		const model = models.get(ref);
		let level = before && before.at < started ? before.level : null;
		if (level !== null && model) level = clampThinkingLevel(model, level);
		if (ref === current.model) {
			if (!current.reasoning) level = null;
		} else if (level === "off") {
			level = null;
		}
		levels.set(started, levels.has(started) ? null : level);
	}

	return messages.map((message) => {
		if (message.role !== "assistant") return message;
		return withEffort(message, levels.get(message.timestamp) ?? null);
	});
}

/**
 * The model the active branch last recorded, as `provider/id`, or null where
 * it records none: the last `model_change` entry or assistant message on it,
 * whichever comes later. That is the model Pi tries to restore on a resume,
 * `getSessionContextSettings` in `core/session-manager.js`, read at the source
 * in `pi 0.87.1`.
 */
export function recordedModel(entries: PiSessionEntry[], leafId: string | null): string | null {
	let model: string | null = null;
	for (const entry of activeBranch(entries, leafId)) {
		if (entry.type === "model_change") {
			model = `${entry.provider}/${entry.modelId}`;
		} else if (entry.type === "message" && entry.message?.role === "assistant") {
			model = `${entry.message.provider}/${entry.message.model}`;
		}
	}
	return model;
}

/** The branch ending at `leafId`, root first: `get_entries` also returns abandoned branches. */
function activeBranch(entries: PiSessionEntry[], leafId: string | null): PiSessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: PiSessionEntry[] = [];
	for (let entry = leafId ? byId.get(leafId) : undefined; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		branch.push(entry);
	}
	return branch.reverse();
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
