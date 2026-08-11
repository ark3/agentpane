/**
 * The Codex event stream -> transcript state machine.
 *
 * Pure: it takes parsed protocol messages in and returns effects out. No
 * subprocess, no sockets, no timers -- which is what lets the whole mapping be
 * driven from `resources/fixtures/codex/*.jsonl` in a unit test (DESIGN
 * "Testing strategy", and the reason D3 keeps this server-side at all).
 *
 * Assembly rules, per DESIGN:
 *
 * - `item/started` creates the placeholder message(s) for an item
 * - deltas append to the right content block, correlated by **`itemId`**
 * - `item/completed` replaces with the authoritative content
 * - `turn/completed` ends the turn
 *
 * Implementation detail that keeps those three from drifting apart: the
 * reducer stores the latest `ThreadItem` per id and applies deltas *to that
 * item*, then re-runs `mapItem`. `started`, `delta`, and `completed` are the
 * same code path with a different input item.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mapItem, usageFromBreakdown, type MapContext } from "./mapping.ts";
import {
	isCodexNotification,
	isCodexResponse,
	isCodexServerRequest,
	isRecord,
	type CodexNotification,
	type CodexServerMessage,
	type RequestId,
	type ThreadItem,
	type ThreadStartResponse,
	type ThreadTokenUsage,
	type Thread,
} from "./protocol.ts";

/**
 * What the reducer asks the shell to do. `index` is a message index, which is
 * exactly the `changedIndex` the adapter contract wants for an O(1) upsert.
 */
export type CodexEffect =
	| { type: "message"; index: number }
	/** The transcript changed wholesale; the server must re-snapshot. */
	| { type: "reset" }
	| { type: "streaming"; isStreaming: boolean }
	/** A `ServerRequest` -- the turn is blocked until it is answered (D2a). */
	| { type: "request"; requestId: RequestId; kind: string; payload: unknown }
	/** Codex resolved a pending request itself (auto-approval, another client). */
	| { type: "request-resolved"; requestId: RequestId }
	| { type: "error"; message: string };

export interface CodexReducerOptions {
	/** Stamped onto assistant messages. Overridden by the `thread/start` response. */
	api?: string;
	provider?: string;
	model?: string;
	/** Injectable clock, so tests are not at the mercy of wall time. */
	now?: () => number;
}

interface Slot {
	item: ThreadItem;
	/** -1 until the item actually produces a message (hidden reasoning never does). */
	messageIndex: number;
	resultIndex: number;
	timestamp: number;
}

const DEFAULT_API = "codex-app-server";
const DEFAULT_PROVIDER = "codex";
const DEFAULT_MODEL = "unknown";

export class CodexReducer {
	private messages: AgentMessage[] = [];
	private slots = new Map<string, Slot>();
	private streaming = false;
	private now: () => number;
	private identity: { api: string; provider: string; model: string };

	/** Latest cumulative diff for the turn (`turn/diff/updated`). */
	turnDiff: string | null = null;
	/** Latest `thread/tokenUsage/updated` payload; drives the cost display. */
	tokenUsage: ThreadTokenUsage | null = null;
	threadId: string | null = null;
	turnId: string | null = null;
	/**
	 * Item types seen but not rendered. Diagnostics only -- an unknown item must
	 * never be an error, because Codex adds `ThreadItem` variants between
	 * releases and the session would die on a routine upgrade.
	 */
	readonly unmappedItemTypes = new Set<string>();

	constructor(options: CodexReducerOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.identity = {
			api: options.api ?? DEFAULT_API,
			provider: options.provider ?? DEFAULT_PROVIDER,
			model: options.model ?? DEFAULT_MODEL,
		};
	}

	getState(): { messages: AgentMessage[]; isStreaming: boolean } {
		return { messages: this.messages, isStreaming: this.streaming };
	}

	get model(): string {
		return this.identity.model;
	}

	get provider(): string {
		return this.identity.provider;
	}

	/** From the `thread/start` / `thread/resume` / `thread/fork` response. */
	setIdentity(id: { model?: string | null; modelProvider?: string | null }): void {
		if (id.model) this.identity.model = id.model;
		if (id.modelProvider) this.identity.provider = id.modelProvider;
	}

	reset(): void {
		this.messages = [];
		this.slots.clear();
		this.streaming = false;
		this.turnDiff = null;
	}

	/**
	 * Cold start (D3): replay a `Thread` fetched with `thread/read
	 * {includeTurns:true}` into a transcript. Items arrive already completed,
	 * so this is the same path with no deltas.
	 */
	hydrate(thread: Pick<Thread, "id" | "turns">): CodexEffect[] {
		this.reset();
		this.threadId = thread.id;
		for (const turn of thread.turns) {
			this.turnId = turn.id;
			const timestamp = (turn.startedAt ?? 0) * 1000 || this.now();
			for (const item of turn.items) this.applyItem(item, timestamp);
		}
		return [{ type: "reset" }];
	}

	/** One parsed line from app-server's stdout. */
	handle(msg: CodexServerMessage): CodexEffect[] {
		if (!isRecord(msg)) return [];
		if (isCodexResponse(msg)) return []; // the JSON-RPC client owns responses
		if (isCodexServerRequest(msg)) {
			return [{ type: "request", requestId: msg.id, kind: msg.method, payload: msg.params }];
		}
		return isCodexNotification(msg) ? this.handleNotification(msg) : [];
	}

	private handleNotification(message: CodexNotification): CodexEffect[] {
		switch (message.method) {
			case "thread/started": {
				this.threadId = message.params.thread.id;
				this.setIdentity({ modelProvider: message.params.thread.modelProvider });
				return [];
			}

			case "thread/status/changed":
				return this.setStreaming(message.params.status.type === "active");

			case "turn/started": {
				this.turnId = message.params.turn.id;
				this.turnDiff = null;
				return this.setStreaming(true);
			}

			case "turn/completed": {
				const turn = message.params.turn;
				const effects: CodexEffect[] = [];
				// NOTE: `turn.items` here is a *summary* view (`itemsView:
				// "summary"` in every fixture) -- only the final agent message.
				// Rebuilding the transcript from it would delete the turn.
				if (turn.status === "failed" && turn.error?.message) {
					effects.push({ type: "error", message: turn.error.message });
				}
				effects.push(...this.setStreaming(false));
				return effects;
			}

			case "turn/diff/updated":
				this.turnDiff = message.params.diff;
				return [];

			case "thread/tokenUsage/updated":
				return this.applyTokenUsage(message.params.tokenUsage);

			case "item/started":
			case "item/completed": {
				const at =
					message.method === "item/completed"
						? message.params.completedAtMs
						: message.params.startedAtMs;
				return this.applyItem(message.params.item, at);
			}

			case "item/agentMessage/delta":
				return this.applyDelta(message.params.itemId, message.params.delta, (item, delta) => {
					if (item.type !== "agentMessage") return false;
					item.text += delta;
					return true;
				});

			case "item/plan/delta":
				return this.applyDelta(message.params.itemId, message.params.delta, (item, delta) => {
					if (item.type !== "plan") return false;
					item.text += delta;
					return true;
				});

			case "item/reasoning/summaryTextDelta":
				return this.applyDelta(message.params.itemId, message.params.delta, (item, delta) => {
					if (item.type !== "reasoning") return false;
					appendAt(item.summary, message.params.summaryIndex, delta);
					return true;
				});

			case "item/reasoning/textDelta":
				return this.applyDelta(message.params.itemId, message.params.delta, (item, delta) => {
					if (item.type !== "reasoning") return false;
					appendAt(item.content, message.params.contentIndex, delta);
					return true;
				});

			case "item/commandExecution/outputDelta":
				return this.applyDelta(message.params.itemId, message.params.delta, (item, delta) => {
					if (item.type !== "commandExecution") return false;
					item.aggregatedOutput = (item.aggregatedOutput ?? "") + delta;
					return true;
				});

			case "item/fileChange/patchUpdated": {
				const slot = this.slotFor(message.params.itemId);
				if (!slot || slot.item.type !== "fileChange") return [];
				slot.item.changes = message.params.changes;
				return this.remap(slot);
			}

			case "serverRequest/resolved":
				return [{ type: "request-resolved", requestId: message.params.requestId }];

			case "error":
				return [{ type: "error", message: message.params.error.message }];

			default:
				// Everything else app-server emits -- account/rateLimits/updated,
				// mcpServer/startupStatus/updated, remoteControl/status/changed,
				// thread/compacted, fs/changed, ... -- is not transcript state.
				return [];
		}
	}

	// -- item assembly ------------------------------------------------------

	private applyItem(item: ThreadItem, timestamp: number): CodexEffect[] {
		const id = item.id;
		const existing = this.slots.get(id);
		// Clone: deltas mutate the stored item in place, and the caller's
		// parsed payload (or a `Thread` we are hydrating from) is not ours.
		const owned = structuredClone(item);
		const slot: Slot = existing
			? { ...existing, item: owned, timestamp }
			: { item: owned, timestamp, messageIndex: -1, resultIndex: -1 };
		this.slots.set(id, slot);
		return this.remap(slot);
	}

	private remap(slot: Slot): CodexEffect[] {
		const ctx: MapContext = { timestamp: slot.timestamp, ...this.identity };
		const mapped = mapItem(slot.item, ctx);
		if (mapped.kind === "none") {
			if (slot.messageIndex < 0) this.unmappedItemTypes.add(slot.item.type);
			return [];
		}
		if (mapped.kind === "single") {
			const index = this.put(slot.messageIndex, mapped.message);
			slot.messageIndex = index;
			return [{ type: "message", index }];
		}
		const callIndex = this.put(slot.messageIndex, mapped.call);
		slot.messageIndex = callIndex;
		const resultIndex = this.put(slot.resultIndex, mapped.result);
		slot.resultIndex = resultIndex;
		return [
			{ type: "message", index: callIndex },
			{ type: "message", index: resultIndex },
		];
	}

	/** Replace at `index`, or append when the slot has no message yet. */
	private put(index: number, message: AgentMessage): number {
		if (index >= 0 && index < this.messages.length) {
			this.messages[index] = message;
			return index;
		}
		this.messages.push(message);
		return this.messages.length - 1;
	}

	private applyDelta(
		itemId: string,
		delta: string,
		apply: (item: ThreadItem, delta: string) => boolean,
	): CodexEffect[] {
		const slot = this.slotFor(itemId);
		if (!slot) return [];
		if (!apply(slot.item, delta)) return [];
		return this.remap(slot);
	}

	private slotFor(itemId: string): Slot | undefined {
		return this.slots.get(itemId);
	}

	// -- turn-level state ---------------------------------------------------

	private setStreaming(isStreaming: boolean): CodexEffect[] {
		if (this.streaming === isStreaming) return [];
		this.streaming = isStreaming;
		return [{ type: "streaming", isStreaming }];
	}

	/**
	 * Token usage is not a message, but it belongs on one: `last` is the usage
	 * of the model request that just finished, so it lands on the most recent
	 * assistant message -- which is what a cost display reads.
	 */
	private applyTokenUsage(usage: ThreadTokenUsage): CodexEffect[] {
		this.tokenUsage = usage;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (!message || message.role !== "assistant") continue;
			const updated: AssistantMessage = { ...message, usage: usageFromBreakdown(usage.last) };
			this.messages[i] = updated;
			return [{ type: "message", index: i }];
		}
		return [];
	}
}

// ---------------------------------------------------------------------------

function appendAt(parts: string[], index: number, delta: string): void {
	while (parts.length <= index) parts.push("");
	parts[index] = (parts[index] ?? "") + delta;
}

/** The `thread/start` response shape we care about, minus the 12 fields we do not. */
export type ThreadIdentityResponse = Pick<ThreadStartResponse, "model" | "modelProvider">;
