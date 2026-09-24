/**
 * In-memory stand-ins for the seams the transport is built against.
 *
 * The real Pi and Codex adapters are built in parallel and this workstream must
 * not depend on either, so the transport's harness is a `BackendAdapter` that
 * drives the interesting cases -- streaming upserts, a blocking server-initiated
 * request, a turn that errors -- deterministically, with no subprocess, no
 * filesystem and no clock.
 *
 * Nothing here imports from `../adapters/pi` or `../adapters/codex`; the whole
 * point is that the transport cannot tell the difference.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	AgentRequest,
	ForkPoint,
	ListSessionsQuery,
	ModelInfo,
	SessionPreviewTurn,
	SessionRef,
	SessionSummary,
} from "../../../shared/protocol.ts";
import { sessionKey } from "../../../shared/protocol.ts";
import type {
	AdapterFactory,
	AdapterState,
	BackendAdapter,
	ForkResult,
	ImageInput,
	StartOptions,
	Unsubscribe,
} from "../../adapters/types.ts";
import type { SessionIndex } from "../deps.ts";

// ---------------------------------------------------------------------------
// message builders -- the shapes the wire actually carries (D6)
// ---------------------------------------------------------------------------

export function userMessage(text: string, timestamp = 0): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function assistantMessage(text: string, timestamp = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fake-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export interface FakeAdapterOptions {
	/** Runs on submit(). Leave unset for a fake that records prompts and nothing else. */
	onSubmit?: (adapter: FakeAdapter, text: string, images?: ImageInput[]) => void | Promise<void>;
	/** Runs on setModel(), before the model is taken; throw to refuse it. */
	onSetModel?: (model: string) => void | Promise<void>;
	models?: ModelInfo[];
	forkPoints?: ForkPoint[];
	/** Make start() fail, to exercise the attach error path. */
	failStart?: string;
	/** Make dispose() fail, to exercise teardown that must not stop at the first casualty. */
	failDispose?: string;
	/**
	 * Make `listModels()` reject until `start()` has run. This is the real
	 * `PiAdapter`, verified: asked before it is started it rejects with "Pi
	 * process is not running", because the answer comes from the subprocess.
	 */
	modelsNeedStart?: boolean;
	/**
	 * Adopt this id when `start()` resolves. Mirrors `PiAdapter`, whose `ref` is
	 * not stable at construction: Pi's session id *is* its JSONL path (D9), so a
	 * session learns its own id from `get_state` during start -- a resumed one,
	 * and a fresh one too as of `pi 0.84.1` (HANDOFF finding 41).
	 */
	materialiseOnStart?: string;
	/**
	 * Adopt this id when the first `submit()` resolves -- a `virtual` session
	 * whose backend names nothing until the first prompt, the case D9 keeps
	 * `PiAdapter`'s post-submit probe for.
	 */
	materialiseOnSubmit?: string;
	/** Emit this state change from inside `start()`, before it resolves. */
	onStart?: (adapter: FakeAdapter) => void;
	/**
	 * Hold `start()` open until this resolves, leaving the adapter parked in the
	 * window both real adapters have: the child is spawned and owned, but
	 * `start()` has not returned so the manager has not recorded the adapter yet.
	 * `CodexAdapter` assigns `this.proc` before its first `initialize` round trip
	 * and `PiAdapter` assigns `this.child` before its `get_state` probe, so a
	 * teardown landing here has a live subprocess to reap.
	 */
	holdStart?: Promise<void>;
	/**
	 * How `fork()` behaves, so the backends' asymmetric forks can be modelled:
	 *  - "pi" (default): the process's active file MOVES, so the adapter adopts a
	 *    new id (`${ref.id}#fork-${entryId}`) and returns it -- `#adoptRef`
	 *    re-keys.
	 *  - "codex": a new thread is minted that this adapter is NOT driving, so its
	 *    own `ref` is left unchanged while `fork()` returns the new thread's ref.
	 *  - "claude": like "codex", except that nothing has recorded the fork yet,
	 *    so `fork()` also returns the `StartOptions` its own adapter needs
	 *    (OW-razoki).
	 *  - "shared": Codex's shape as of OW-lajehi -- the fork can only be driven
	 *    by the process that minted it, so `fork()` hands back an adapter it
	 *    built itself, already holding a share of that process, and the manager
	 *    must start THAT rather than ask the factory for one.
	 */
	forkMode?: "pi" | "codex" | "claude" | "shared";
	/**
	 * The subprocess this adapter shares with the adapters it forked. Present
	 * only for `forkMode: "shared"`; a test reads `kills` to prove the last
	 * holder out is the one that kills the child, and that it happens once.
	 */
	sharedChild?: FakeSharedChild;
	/**
	 * Options the borrower `forkMode: "shared"` builds is given on top of these,
	 * so a test can make the FORK's `start()` fail or hang without touching the
	 * parent's.
	 */
	forkOptions?: FakeAdapterOptions;
}

/**
 * A subprocess several `FakeAdapter`s hold at once, so a test can assert the
 * refcount rather than the adapter count (OW-lajehi). A holder is taken at
 * construction -- which for a fork means at fork time, not at attach.
 */
export class FakeSharedChild {
	holders = 0;
	kills = 0;

	hold(): void {
		this.holders += 1;
	}

	release(): void {
		this.holders -= 1;
		if (this.holders === 0) this.kills += 1;
	}
}

/** A promise a test resolves by hand, to park an adapter mid-`start()`. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export class FakeAdapter implements BackendAdapter {
	// -- observable by tests -------------------------------------------------
	started = false;
	disposed = false;
	/** Dispose is reached from several paths; a leak and a double-kill both show up here. */
	disposals = 0;
	startOptions?: StartOptions;
	readonly prompts: { text: string; images?: ImageInput[] }[] = [];
	readonly replies: { requestId: string; response: unknown }[] = [];
	readonly forks: string[] = [];
	aborts = 0;
	compactions = 0;
	model?: string;
	effort?: string;
	/** What `AdapterState.unrestoredModel` reports; set it and emit to drive a change. */
	unrestoredModel?: string;

	// -- state ---------------------------------------------------------------
	messages: AgentMessage[] = [];
	isStreaming = false;
	compaction: "requesting" | "running" | null = null;

	#updates = new Set<(state: AdapterState, changedIndex?: number) => void>();
	#requests = new Set<(request: AgentRequest) => void>();
	#errors = new Set<(message: string) => void>();
	#nextRequestId = 1;

	/** Not stable at construction -- see `materialiseOnStart`/`materialiseOnSubmit`. */
	get ref(): SessionRef {
		return this.#ref;
	}
	#ref: SessionRef;

	constructor(
		ref: SessionRef,
		private readonly options: FakeAdapterOptions = {},
	) {
		this.#ref = ref;
		if (options.forkMode === "shared") options.sharedChild?.hold();
	}

	async start(opts: StartOptions): Promise<void> {
		if (this.options.holdStart) await this.options.holdStart;
		if (this.options.failStart) throw new Error(this.options.failStart);
		this.startOptions = opts;
		this.started = true;
		this.options.onStart?.(this);
		if (this.options.materialiseOnStart) this.materialiseAs(this.options.materialiseOnStart);
	}

	async dispose(): Promise<void> {
		const first = !this.disposed;
		this.disposed = true;
		this.disposals++;
		this.#updates.clear();
		this.#requests.clear();
		this.#errors.clear();
		if (first && this.options.forkMode === "shared") this.options.sharedChild?.release();
		if (this.options.failDispose) throw new Error(this.options.failDispose);
	}

	async submit(text: string, images?: ImageInput[]): Promise<void> {
		this.prompts.push({ text, images });
		await this.options.onSubmit?.(this, text, images);
		if (this.prompts.length === 1 && this.options.materialiseOnSubmit) {
			this.materialiseAs(this.options.materialiseOnSubmit);
		}
	}

	/** Adopt a real backend id, as Pi does once it names the file it just wrote. */
	materialiseAs(id: string): void {
		this.#ref = { ...this.#ref, id };
	}

	async abort(): Promise<void> {
		this.aborts++;
		this.setStreaming(false);
	}

	async compact(): Promise<void> {
		this.compactions++;
		this.setCompaction("requesting");
	}

	async listForkPoints(): Promise<ForkPoint[]> {
		return this.options.forkPoints ?? [];
	}

	async fork(entryId: string): Promise<ForkResult> {
		this.forks.push(entryId);
		const parentId = this.ref.id;
		const forkedRef = { backend: this.ref.backend, id: `${parentId}#fork-${entryId}` };
		// Codex and Claude Code mint a conversation this adapter does not drive:
		// its own ref is unchanged, and the returned ref is the new one. Pi's
		// active file moves, so the adapter adopts the new id and returns it.
		if (this.options.forkMode === "claude") {
			return {
				ref: forkedRef,
				start: { cwd: this.startOptions?.cwd ?? "", forkOf: { parentId, entryId } },
			};
		}
		if (this.options.forkMode === "shared") {
			// The fork's adapter is built HERE, already holding a share of this
			// adapter's child, because only that child can drive the fork.
			return {
				ref: forkedRef,
				start: { cwd: this.startOptions?.cwd ?? "", resumeId: forkedRef.id },
				adapter: new FakeAdapter(forkedRef, { ...this.options, ...this.options.forkOptions }),
			};
		}
		if (this.options.forkMode !== "codex") this.#ref = forkedRef;
		return { ref: forkedRef };
	}

	getState(): AdapterState {
		return { messages: this.messages, isStreaming: this.isStreaming, compaction: this.compaction, model: this.model ?? null, effort: this.effort ?? null, unrestoredModel: this.unrestoredModel ?? null };
	}

	onUpdate(cb: (state: AdapterState, changedIndex?: number) => void): Unsubscribe {
		this.#updates.add(cb);
		return () => this.#updates.delete(cb);
	}

	onRequest(cb: (request: AgentRequest) => void): Unsubscribe {
		this.#requests.add(cb);
		return () => this.#requests.delete(cb);
	}

	onError(cb: (message: string) => void): Unsubscribe {
		this.#errors.add(cb);
		return () => this.#errors.delete(cb);
	}

	async setModel(model: string): Promise<void> {
		await this.options.onSetModel?.(model);
		this.model = model;
		this.#emit(undefined);
	}

	async setEffort(effort: string): Promise<void> {
		this.effort = effort;
		this.#emit(undefined);
	}

	async listModels(): Promise<ModelInfo[]> {
		if (this.options.modelsNeedStart && !this.started) {
			throw new Error("Pi process is not running");
		}
		return this.options.models ?? [];
	}

	// -- test drivers --------------------------------------------------------

	/** Append a message and report its index -- the O(1) tail path (D3). */
	append(message: AgentMessage): number {
		const index = this.messages.length;
		this.messages = [...this.messages, message];
		this.#emit(index);
		return index;
	}

	/** Replace the tail in place, as a streaming token does. */
	replaceTail(message: AgentMessage): number {
		const index = Math.max(0, this.messages.length - 1);
		this.messages = [...this.messages.slice(0, index), message];
		this.#emit(index);
		return index;
	}

	/** Grow the tail assistant message by one token, appending it if absent. */
	streamToken(token: string): number {
		const tail = this.messages[this.messages.length - 1];
		if (!tail || tail.role !== "assistant") return this.append(assistantMessage(token));
		const text = tail.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		return this.replaceTail(assistantMessage(text + token));
	}

	/** A state change the adapter cannot localise -- the server must fall back to a snapshot. */
	emitUnlocalisedChange(): void {
		this.#emit(undefined);
	}

	setStreaming(isStreaming: boolean, changedIndex?: number): void {
		this.isStreaming = isStreaming;
		this.#emit(changedIndex ?? this.messages.length - 1);
	}

	setCompaction(compaction: "requesting" | "running" | null, changedIndex?: number): void {
		this.compaction = compaction;
		this.#emit(changedIndex);
	}

	/** The agent blocks until this is answered (D2a). */
	emitRequest(kind: string, payload: unknown = {}): AgentRequest {
		const request: AgentRequest = {
			requestId: `${sessionKey(this.ref)}#${this.#nextRequestId++}`,
			session: this.ref,
			kind,
			payload,
		};
		for (const cb of [...this.#requests]) cb(request);
		return request;
	}

	emitError(message: string): void {
		for (const cb of [...this.#errors]) cb(message);
	}

	async reply(requestId: string, response: unknown): Promise<void> {
		this.replies.push({ requestId, response });
	}

	#emit(changedIndex?: number): void {
		const state = this.getState();
		for (const cb of [...this.#updates]) cb(state, changedIndex);
	}
}

export class FakeAdapterFactory implements AdapterFactory {
	readonly created: FakeAdapter[] = [];
	/** The ref each adapter was constructed with, which its own `ref` may outgrow. */
	readonly createdFor: SessionRef[] = [];

	constructor(private readonly options: FakeAdapterOptions = {}) {}

	create(ref: SessionRef): FakeAdapter {
		const adapter = new FakeAdapter(ref, this.options);
		this.created.push(adapter);
		this.createdFor.push(ref);
		return adapter;
	}

	/**
	 * The most recently created adapter for a session, found by either the id it
	 * was created with or the one it has since adopted -- so a test written
	 * against the ref it was created with keeps working across the rename.
	 */
	forRef(ref: SessionRef): FakeAdapter | undefined {
		const key = sessionKey(ref);
		for (let i = this.created.length - 1; i >= 0; i--) {
			const adapter = this.created[i] as FakeAdapter;
			if (sessionKey(adapter.ref) === key) return adapter;
			if (sessionKey(this.createdFor[i] as SessionRef) === key) return adapter;
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// session index
// ---------------------------------------------------------------------------

/** Stands in for the on-disk walk (D9) without touching a filesystem. */
export class FakeSessionIndex implements SessionIndex {
	/** Records every ref the preview route asked for, so a test can prove it was used. */
	readonly previewed: SessionRef[] = [];

	constructor(
		public summaries: SessionSummary[] = [],
		/** Canned preview turns keyed by `sessionKey(ref)`. */
		public previews: Map<string, SessionPreviewTurn[]> = new Map(),
	) {}

	async list(query?: ListSessionsQuery): Promise<SessionSummary[]> {
		return query?.cwd ? this.summaries.filter((s) => s.cwd === query.cwd) : this.summaries;
	}

	async get(ref: SessionRef): Promise<SessionSummary | null> {
		return this.summaries.find((s) => sessionKey(s.ref) === sessionKey(ref)) ?? null;
	}

	async preview(ref: SessionRef): Promise<SessionPreviewTurn[]> {
		this.previewed.push(ref);
		return this.previews.get(sessionKey(ref)) ?? [];
	}
}

export function storedSession(ref: SessionRef, cwd: string, at = "2026-08-10T00:00:00.000Z"): SessionSummary {
	return {
		ref,
		cwd,
		preview: "hello",
		createdAt: at,
		updatedAt: at,
		status: "detached",
		isStreaming: false,
		onDisk: true,
	};
}
