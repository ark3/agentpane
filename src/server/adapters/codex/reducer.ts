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
 * - `item/started` creates the placeholder message(s) for an item -- or, for
 *   an item that started before a re-attach, its first delta does, and the
 *   history paged in after supplies the head (see `hydrate`)
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
import type { AgentNotice } from "../../../shared/protocol.ts";
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
	/**
	 * A turn the history listed running whose `turn/started` this reducer never
	 * heard: it went out before a re-attach joined the stream (OW-dirazu). The
	 * shell adopts it as though that notification had arrived.
	 */
	| { type: "running-turn"; turnId: string }
	| { type: "compaction"; compaction: "requesting" | "running" | null }
	/** A `ServerRequest` -- the turn is blocked until it is answered (D2a, OW-futewo). */
	| { type: "request"; requestId: RequestId; kind: string; payload: unknown; issuerThreadId?: string | null }
	/** Codex says a request it sent is no longer pending (`serverRequest/resolved`). */
	| { type: "request-resolved"; requestId: RequestId }
	| { type: "error"; message: string }
	/** A warning Codex sent that is neither a failure nor transcript state (OW-tujiya). */
	| { type: "notice"; notice: AgentNotice };

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
	/** Current visible contribution, flattened with other slots in item event order. */
	messages: AgentMessage[];
	timestamp: number;
	completed: boolean;
	/**
	 * Non-null for a headless slot: one a delta opened, for an item whose
	 * `item/started` this reducer never heard, so it lacks whatever streamed
	 * before (see `applyDelta`). Holds the deltas that arrived since the last
	 * history page was asked for, which a listed copy of the item cannot hold
	 * (see `hydrate`). Null once `item/completed` makes the slot whole.
	 */
	sincePage: ((item: ThreadItem) => boolean)[] | null;
}

const DEFAULT_API = "codex-app-server";
const DEFAULT_PROVIDER = "codex";
const DEFAULT_MODEL = "unknown";

export class CodexReducer {
	private messages: AgentMessage[] = [];
	private slots = new Map<string, Slot>();
	private streaming = false;
	private compaction: "requesting" | "running" | null = null;
	/**
	 * Non-null between the first `pageRequested` and `hydrate`, which is only
	 * on a borrowed re-attach: the history is being paged in, so a headless
	 * slot keeps its deltas for the merge. `turn` records that the stream has
	 * settled the running turn since -- a `turn/started`, a `turn/completed`,
	 * or a `thread/status/changed` to anything but `active`, which names no
	 * turn -- and `compaction` that it set compaction state; either is newer
	 * than any page and so wins over what the listing says of it (OW-dirazu).
	 */
	private pageRead: { turn: boolean; compaction: boolean } | null = null;
	private now: () => number;
	private identity: { api: string; provider: string; model: string; effort: string | null };

	/** Latest cumulative diff for the turn (`turn/diff/updated`). */
	turnDiff: string | null = null;
	/** Latest `thread/tokenUsage/updated` payload; drives the cost display. */
	tokenUsage: ThreadTokenUsage | null = null;
	/**
	 * Context size at the moment each compaction started, by item id (OW-kelomi).
	 *
	 * Sampled at `item/started` and not later: `thread/tokenUsage/updated` fires
	 * three more times before the matching `item/completed`
	 * (`resources/fixtures/codex/compact.jsonl`, `codex-cli 0.147.0`: `last.
	 * totalTokens` 16304 at the start, then 14692, then 4844), so reading
	 * `this.tokenUsage` when the completed item is mapped would label the shrunk
	 * context "before". Keyed by id rather than kept as one field so that a
	 * second compaction cannot lend its figure to the first, and so that a
	 * hydrated item -- which has no `item/started` -- reports nothing instead of
	 * something borrowed.
	 */
	private compactionTokensBefore = new Map<string, number>();
	threadId: string | null = null;
	turnId: string | null = null;
	/**
	 * The turn an `error` notification already reported. As of `codex-cli
	 * 0.156.0` a turn the upstream API refused sent that notification and then
	 * a failed `turn/completed` carrying the same error (docs/MANUAL_TESTING.md,
	 * OW-wawuzu), and a second report would show the user the line twice.
	 */
	private reportedErrorTurnId: string | null = null;
	/**
	 * Item types Codex sent that this build has no mapping for. Diagnostics only
	 * -- an unknown item must never be an error, because Codex adds `ThreadItem`
	 * variants between releases and the session would die on a routine upgrade.
	 *
	 * Only genuinely unknown types land here. The other two ways an item maps to
	 * nothing -- a hidden reasoning item, and the types in `SILENT_ITEM_TYPES` --
	 * are working as designed, and collecting them would bury the one signal this
	 * set exists to carry (OW-mezeso).
	 */
	readonly unmappedItemTypes = new Set<string>();

	constructor(options: CodexReducerOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.identity = {
			api: options.api ?? DEFAULT_API,
			provider: options.provider ?? DEFAULT_PROVIDER,
			model: options.model ?? DEFAULT_MODEL,
			// Unknown until the start/resume response arrives, and legitimately
			// absent after it for a model with no effort setting.
			effort: null,
		};
	}

	getState(): { messages: AgentMessage[]; isStreaming: boolean; compaction: "requesting" | "running" | null } {
		return { messages: this.messages, isStreaming: this.streaming, compaction: this.compaction };
	}

	requestCompaction(): CodexEffect[] {
		return this.setCompaction("requesting");
	}

	cancelCompaction(): CodexEffect[] {
		return this.setCompaction(null);
	}

	get model(): string {
		return this.identity.model;
	}

	get provider(): string {
		return this.identity.provider;
	}

	get effort(): string | null {
		return this.identity.effort;
	}

	/** From the `thread/start` / `thread/resume` / `thread/fork` response, and the effort a `turn/start` overrides. */
	setIdentity(id: {
		threadId?: string | null;
		model?: string | null;
		modelProvider?: string | null;
		reasoningEffort?: string | null;
	}): void {
		if (id.threadId) this.threadId = id.threadId;
		if (id.model) this.identity.model = id.model;
		if (id.modelProvider) this.identity.provider = id.modelProvider;
		if (id.reasoningEffort) this.identity.effort = id.reasoningEffort;
	}

	/**
	 * Replay a thread's turns, paged in with `thread/turns/list` at
	 * `itemsView: "full"`, into a transcript: the whole of it on a cold start
	 * (D3), and merged with the live stream on a borrowed re-attach. A listed
	 * item takes the same path as a live one; only a headless slot's deltas
	 * are laid on it.
	 *
	 * The merge (OW-vijuyi). A re-attach over an app-server that still holds
	 * the thread hears it from `CodexAdapter.adoptConnection` on, so a turn
	 * still running there streams while the history is paged in. The listing
	 * owns what went before the attach, and the stream what came after it:
	 *
	 * - An item the stream opened with `item/started`, or completed, keeps its
	 *   live slot in place of the listed copy, since that slot holds the whole
	 *   of it -- so its text shows once whether or not the listing held it.
	 * - A headless slot, one a delta opened (`applyDelta`), yields to a listed
	 *   copy, which holds the head the slot lacks, and only the deltas that
	 *   arrived after the page was asked for (`pageRequested`) are laid on top
	 *   of it: the ones before, the page already holds (OW-dirazu).
	 * - A live slot the listing lacks follows the history. As of `codex-cli
	 *   0.156.0` that was every item still streaming -- an `agentMessage`,
	 *   `reasoning`, `plan` and `commandExecution` alike were listed only once
	 *   complete (docs/MANUAL_TESTING.md, OW-dutute and OW-dirazu) -- so a
	 *   headless slot's head showed only when `item/completed` replaced it.
	 *
	 * The running turn is the listing's too, unless the stream has settled it
	 * since the page was asked for. As of that version `thread/resume` read
	 * the thread `active` but named no turn and replayed no `turn/started`,
	 * and the listing named the turn `inProgress`: a user turn with its
	 * `userMessage` first, a compaction's with no items at all. So a last turn
	 * listed `inProgress` is streaming, and a compaction when it lists no items
	 * at all, and its id goes to the shell as a `running-turn` effect -- save
	 * that a turn the stream settled during the read, or compaction state it
	 * set, wins over the listing's (see `pageRead`). Only on a re-attach: a
	 * cold start's app-server is fresh and can be running no turn, whatever
	 * its listing says.
	 */
	hydrate(thread: Pick<Thread, "id" | "turns">): CodexEffect[] {
		const live = this.slots;
		this.slots = new Map();
		this.threadId = thread.id;
		const read = this.pageRead;
		this.pageRead = null;
		for (const turn of thread.turns) {
			this.turnId = turn.id;
			const timestamp = (turn.startedAt ?? 0) * 1000 || this.now();
			for (const item of turn.items) {
				const slot = live.get(item.id);
				const headless = read ? slot?.sincePage : null;
				if (slot && !headless) {
					this.slots.set(item.id, slot);
					continue;
				}
				this.applyItem(item, timestamp, !slot);
				const merged = this.slots.get(item.id);
				if (!merged || !headless) continue;
				for (const apply of headless) apply(merged.item);
				this.remap(merged);
			}
		}
		for (const [id, slot] of live) if (!this.slots.has(id)) this.slots.set(id, slot);
		this.messages = this.flattenMessages();

		const effects: CodexEffect[] = [];
		const last = thread.turns.at(-1);
		if (read && !read.turn && last?.status === "inProgress") {
			this.streaming = true;
			if (!read.compaction && last.items.length === 0) this.compaction = "running";
			effects.push({ type: "running-turn", turnId: last.id });
		}
		effects.push({ type: "reset" });
		return effects;
	}

	/**
	 * A history page is about to be asked for, so it will hold every delta
	 * this reducer has seen: from here on a headless slot keeps what arrives
	 * for `hydrate` to lay on the listed copy. Called before each page, since
	 * the running turn is on the last.
	 *
	 * As of `codex-cli 0.156.0` no line arrived between a listing's request
	 * and its answer (docs/MANUAL_TESTING.md, OW-dirazu), so the request is
	 * where the page's edge was measured to be. A delta Codex wrote in that
	 * window and also listed would be laid on twice; none has been seen, and
	 * no partial item was ever listed for one to belong to.
	 */
	pageRequested(): void {
		this.pageRead ??= { turn: false, compaction: false };
		for (const slot of this.slots.values()) if (slot.sincePage) slot.sincePage = [];
	}

	/** One parsed line from app-server's stdout. */
	handle(msg: CodexServerMessage): CodexEffect[] {
		if (!isRecord(msg)) return [];
		if (isCodexResponse(msg)) return []; // the JSON-RPC client owns responses
		if (isCodexServerRequest(msg)) {
			const issuerThreadId = this.extractIssuerThreadId(msg.params);
			return [{ type: "request", requestId: msg.id, kind: msg.method, payload: msg.params, issuerThreadId }];
		}
		return isCodexNotification(msg) ? this.handleNotification(msg) : [];
	}

	/**
	 * Extract the `threadId` from a ServerRequest payload and return it only if it
	 * differs from this reducer's own thread id (i.e., the request originates from a child thread).
	 */
	private extractIssuerThreadId(params: unknown): string | null {
		if (!isRecord(params)) return null;
		const payloadThreadId = params.threadId;
		if (typeof payloadThreadId !== "string") return null;
		// Return the issuer's thread id only if it differs from the reducer's own thread
		return payloadThreadId !== this.threadId ? payloadThreadId : null;
	}

	private handleNotification(message: CodexNotification): CodexEffect[] {
		// Ahead of the thread guard: a subagent thread's request is routed to its
		// parent's adapter (`CodexConnection.#recipientFor`, OW-futewo), but its
		// resolution names the child's thread and the guard would drop it. The
		// wire id is what identifies the request -- JSON-RPC gives the
		// connection one id space -- and only the adapter that published it
		// holds a mapping for that id (OW-gusifo).
		if (message.method === "serverRequest/resolved") {
			return [{ type: "request-resolved", requestId: message.params.requestId }];
		}
		const notificationThreadId = threadIdOf(message);
		if (this.threadId && notificationThreadId && notificationThreadId !== this.threadId) return [];

		switch (message.method) {
			case "thread/started": {
				this.threadId = message.params.thread.id;
				this.setIdentity({ modelProvider: message.params.thread.modelProvider });
				return [];
			}

			case "thread/status/changed":
				// `active` names no turn, so it leaves the listing to name the
				// running one; any other status settles that none is running.
				if (this.pageRead && message.params.status.type !== "active") this.pageRead.turn = true;
				return this.setStreaming(message.params.status.type === "active");

			case "turn/started": {
				if (this.pageRead) this.pageRead.turn = true;
				this.turnId = message.params.turn.id;
				this.turnDiff = null;
				return this.setStreaming(true);
			}

			case "turn/completed": {
				const turn = message.params.turn;
				if (this.pageRead) this.pageRead.turn = true;
				const effects: CodexEffect[] = this.setCompaction(null);
				// NOTE: `turn.items` here is a *summary* view (`itemsView:
				// "summary"` in every fixture) -- only the final agent message.
				// Rebuilding the transcript from it would delete the turn.
				if (turn.status === "failed" && turn.error?.message && turn.id !== this.reportedErrorTurnId) {
					effects.push({ type: "error", message: upstreamMessage(turn.error.message) });
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
				const completed = message.method === "item/completed";
				const at =
					completed
						? message.params.completedAtMs
						: message.params.startedAtMs;
				if (message.params.item.type === "contextCompaction") {
					if (!completed) {
						// The only moment the pre-compaction context size is still live.
						const before = this.tokenUsage?.last.totalTokens ?? 0;
						this.compactionTokensBefore.set(message.params.item.id, before);
						return this.setCompaction("running");
					}
					this.compaction = null;
					if (this.pageRead) this.pageRead.compaction = true;
				}
				return this.applyItem(message.params.item, at, completed);
			}

			case "item/agentMessage/delta":
				return this.applyDelta(message.params.itemId, message.params.delta, openAgentMessage, (item, delta) => {
					if (item.type !== "agentMessage") return false;
					item.text += delta;
					return true;
				});

			case "item/plan/delta":
				return this.applyDelta(message.params.itemId, message.params.delta, openPlan, (item, delta) => {
					if (item.type !== "plan") return false;
					item.text += delta;
					return true;
				});

			case "item/reasoning/summaryTextDelta":
				return this.applyDelta(message.params.itemId, message.params.delta, openReasoning, (item, delta) => {
					if (item.type !== "reasoning") return false;
					appendAt(item.summary, message.params.summaryIndex, delta);
					return true;
				});

			case "item/reasoning/textDelta":
				return this.applyDelta(message.params.itemId, message.params.delta, openReasoning, (item, delta) => {
					if (item.type !== "reasoning") return false;
					appendAt(item.content, message.params.contentIndex, delta);
					return true;
				});

			case "item/commandExecution/outputDelta":
				return this.applyDelta(message.params.itemId, message.params.delta, null, (item, delta) => {
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

			case "error":
				// Read from `resources/codex-protocol/v2/ErrorNotification.ts`, not
				// measured: `willRetry` means Codex is still running the turn, and a
				// non-retrying error or a failed `turn/completed` follows if retries
				// run out. Reporting it would leave a stale banner over a retry that
				// then succeeds, and clearing compaction would reopen the steer path
				// into a compact turn that is still live.
				if (message.params.willRetry) return [];
				this.reportedErrorTurnId = message.params.turnId;
				return [
					...this.setCompaction(null),
					{ type: "error", message: upstreamMessage(message.params.error.message) },
				];

			// Not errors (OW-tujiya): as of `codex-cli 0.156.0` a `turn/start` on a
			// model with no metadata drew a `warning` and then ran the turn
			// (docs/MANUAL_TESTING.md, OW-wawuzu), so none of these may reach the
			// `error` effect, whose contract is a turn that failed. A thread-scoped
			// one for another thread never gets here: the guard above drops it. One
			// for a thread no session drives arrives with its `threadId` nulled
			// (`CodexConnection.#deliver`, OW-weyefe).
			case "warning":
			case "guardianWarning":
				return [{ type: "notice", notice: { kind: message.method, message: message.params.message, details: null, path: null } }];

			case "deprecationNotice":
				return [
					{
						type: "notice",
						notice: { kind: message.method, message: message.params.summary, details: message.params.details, path: null },
					},
				];

			case "configWarning": {
				const { summary, details, path, range } = message.params;
				const at = path && range ? `${path}:${range.start.line}:${range.start.column}` : (path ?? null);
				return [{ type: "notice", notice: { kind: message.method, message: summary, details, path: at } }];
			}

			default:
				// Everything else app-server emits -- account/rateLimits/updated,
				// mcpServer/startupStatus/updated, remoteControl/status/changed,
				// thread/compacted, fs/changed, windows/worldWritableWarning, ... --
				// is not transcript state, and not surfaced; the four warnings
				// above are.
				return [];
		}
	}

	// -- item assembly ------------------------------------------------------

	private applyItem(item: ThreadItem, timestamp: number, completed: boolean): CodexEffect[] {
		const id = item.id;
		const existing = this.slots.get(id);
		// Clone: deltas mutate the stored item in place, and the caller's
		// parsed payload (or a `Thread` we are hydrating from) is not ours.
		const owned = structuredClone(item);
		const slot: Slot = existing
			? { ...existing, item: owned, completed, sincePage: null }
			: { item: owned, messages: [], timestamp, completed, sincePage: null };
		this.slots.set(id, slot);
		return this.remap(slot);
	}

	private remap(slot: Slot): CodexEffect[] {
		const previousCount = slot.messages.length;
		const previousLength = this.messages.length;
		const startIndex = this.startIndex(slot);
		const ctx: MapContext = {
			timestamp: slot.timestamp,
			completed: slot.completed,
			tokensBefore: this.compactionTokensBefore.get(slot.item.id) ?? 0,
			...this.identity,
		};
		const mapped = mapItem(slot.item, ctx);
		let next: AgentMessage[];
		if (mapped.kind === "none") {
			if (mapped.unknownType) this.unmappedItemTypes.add(slot.item.type);
			next = [];
		} else if (mapped.kind === "single") {
			next = [mapped.message];
		} else {
			next = mapped.result ? [mapped.call, mapped.result] : [mapped.call];
		}

		slot.messages = next;
		this.messages = this.flattenMessages();
		if (previousCount === 0 && next.length === 0) return [];

		// Upserts cannot express deletion or insertion before an existing
		// message. Those structural changes require an authoritative snapshot.
		if (
			next.length < previousCount ||
			(next.length > previousCount && startIndex + previousCount < previousLength)
		) {
			return [{ type: "reset" }];
		}
		return next.map((_, offset) => ({ type: "message", index: startIndex + offset }));
	}

	/**
	 * Where the item's first transcript message sits in the flat array, or null
	 * when this reducer has never seen the item (OW-roveze).
	 *
	 * The bridge from a Codex `ThreadItem.id` to the index space `getState()`
	 * hands out -- the only correct one. A position within `turn.items` is not:
	 * `mapItem` answers zero messages for a hidden reasoning item, for every
	 * `SILENT_ITEM_TYPES` member and for any item type a newer `codex-cli` adds,
	 * and two for a tool call with a result.
	 */
	indexOfItem(itemId: string): number | null {
		const slot = this.slots.get(itemId);
		if (!slot || slot.messages.length === 0) return null;
		return this.startIndex(slot);
	}

	private startIndex(target: Slot): number {
		let index = 0;
		for (const slot of this.slots.values()) {
			if (slot === target) return index;
			index += slot.messages.length;
		}
		return index;
	}

	private flattenMessages(): AgentMessage[] {
		return [...this.slots.values()].flatMap((slot) => slot.messages);
	}

	/**
	 * A delta for an item this reducer has no slot for opens one, from the
	 * empty item `open` builds, when the delta's kind says what the item is
	 * (OW-zudase). That is an item whose `item/started` went out before
	 * `CodexAdapter.adoptConnection` joined the stream on a re-attach, and as
	 * of `codex-cli 0.156.0` nothing else carried its text until
	 * `item/completed`: `thread/turns/list` left every item still streaming
	 * out of the running turn it listed, and `thread/resume` replayed no
	 * `item/started` (docs/MANUAL_TESTING.md, OW-dutute and OW-dirazu). The
	 * slot is headless -- it holds what streamed from the attach on, not the
	 * head before it -- so a listed copy wins over it in `hydrate`, and
	 * `item/completed` replaces it with the whole item where it stands. A
	 * command's output has no `open`: alone it names no command to draw.
	 */
	private applyDelta(
		itemId: string,
		delta: string,
		open: ((id: string) => ThreadItem) | null,
		apply: (item: ThreadItem, delta: string) => boolean,
	): CodexEffect[] {
		let slot = this.slotFor(itemId);
		if (!slot && open) {
			slot = { item: open(itemId), messages: [], timestamp: this.now(), completed: false, sincePage: [] };
			this.slots.set(itemId, slot);
		}
		if (!slot) return [];
		if (!apply(slot.item, delta)) return [];
		if (slot.sincePage && this.pageRead) slot.sincePage.push((item) => apply(item, delta));
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

	private setCompaction(compaction: "requesting" | "running" | null): CodexEffect[] {
		if (this.pageRead) this.pageRead.compaction = true;
		if (this.compaction === compaction) return [];
		this.compaction = compaction;
		return [{ type: "compaction", compaction }];
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
			for (const slot of this.slots.values()) {
				const localIndex = slot.messages.indexOf(message);
				if (localIndex >= 0) {
					slot.messages[localIndex] = updated;
					break;
				}
			}
			return [{ type: "message", index: i }];
		}
		return [];
	}
}

// ---------------------------------------------------------------------------

/** The empty items a delta opens a slot with; see `CodexReducer.applyDelta`. */
function openAgentMessage(id: string): ThreadItem {
	return { type: "agentMessage", id, text: "", phase: null, memoryCitation: null, delivery: null, questions: null };
}

function openPlan(id: string): ThreadItem {
	return { type: "plan", id, text: "" };
}

function openReasoning(id: string): ThreadItem {
	return { type: "reasoning", id, summary: [], content: [] };
}

function appendAt(parts: string[], index: number, delta: string): void {
	while (parts.length <= index) parts.push("");
	parts[index] = (parts[index] ?? "") + delta;
}

/**
 * The sentence inside an upstream API error, or the message unchanged.
 *
 * As of `codex-cli 0.156.0` a refusal from the upstream API arrived as that
 * API's response serialized into `error.message` --
 * `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"..."}}`
 * (docs/MANUAL_TESTING.md, OW-wawuzu) -- while Codex's own errors are plain
 * text, such as a stream reset.
 */
function upstreamMessage(message: string): string {
	try {
		const parsed: unknown = JSON.parse(message);
		if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
			return parsed.error.message;
		}
	} catch {
		// Not JSON: a plain-text message.
	}
	return message;
}

/**
 * The thread a notification is about, or null for one that names none.
 *
 * Load-bearing twice over, because more than one thread's notifications come
 * down one connection: a spawned agent is a thread of its own sharing its
 * parent's connection (D19), and since OW-lajehi a fork is too -- the parent's
 * app-server is the only process that may drive it. The guard in
 * `handleNotification` that reads this is what keeps one thread's stream out of
 * another's transcript, and it is only armed once `threadId` is set, which is
 * why `CodexAdapter.adoptConnection` seeds a borrower's identity before it
 * joins the stream.
 */
function threadIdOf(message: CodexNotification): string | null {
	if (message.method === "thread/started") return message.params.thread.id;
	const params: unknown = message.params;
	return isRecord(params) && typeof params.threadId === "string" ? params.threadId : null;
}
