/**
 * `BackendAdapter` for Codex.
 *
 * This is the shell: spawn, JSON-RPC, and the lifecycle/command surface. All
 * of the item->message translation lives in `reducer.ts` / `mapping.ts`, which
 * this class drives and never second-guesses. The split is what lets the hard
 * half be tested against recorded fixtures with no subprocess at all.
 */

import { randomUUID } from "node:crypto";
import type { AgentRequest, ForkPoint, ModelInfo, SessionRef } from "../../../shared/protocol.ts";
import type {
	AdapterState,
	BackendAdapter,
	AdapterFactory,
	ImageInput,
	StartOptions,
	Unsubscribe,
} from "../types.ts";
import { CodexClient } from "./jsonrpc.ts";
import { spawnCodex, type CodexProcess, type CodexSpawner } from "./process.ts";
import { CodexReducer, type CodexEffect } from "./reducer.ts";
import {
	DECLINE_RESPONSES,
	wireRequestKey,
	type AskForApproval,
	type ClientInfo,
	type CodexServerMessage,
	type ModelListResponse,
	type RequestId,
	type SandboxMode,
	type Thread,
	type ThreadForkResponse,
	type ThreadReadResponse,
	type ThreadResumeResponse,
	type ThreadStartResponse,
	type TurnStartResponse,
	type UserInput,
} from "./protocol.ts";

export interface CodexAdapterOptions {
	/** Injected in tests; the default spawns `direnv exec <cwd> sbox -- codex app-server`. */
	spawn?: CodexSpawner;
	clientInfo?: ClientInfo;
	/**
	 * Start threads with `ephemeral: true`, which keeps them out of the on-disk
	 * rollout store under `~/.codex/sessions` (HANDOFF finding 25). Tests set
	 * this so nothing they do reaches the real store.
	 *
	 * NOTE: the frozen `StartOptions` has no field for this, so it is an
	 * adapter-construction option rather than a per-start one.
	 */
	ephemeral?: boolean;
	/**
	 * Start threads with this sandbox policy. Defaults to `danger-full-access`:
	 * agentpane already runs Codex inside sbox's bwrap jail, so the OS layer is
	 * the confinement boundary and anything narrower would re-implement sbox's
	 * mount list in a second place that will drift.
	 */
	sandbox?: SandboxMode;
	/**
	 * Start threads with this approval policy. Defaults to `never` (D7a):
	 * agentpane's UI has no approval dialog, so an approval `ServerRequest`
	 * renders as an unsupported-request warning and hangs the turn until the
	 * session is killed. Codex's own default is `on-request`, so this has to be
	 * sent explicitly; it belongs here rather than in sbox's flags or a global
	 * `~/.codex/config.toml` for the reasons D7a gives.
	 */
	approvalPolicy?: AskForApproval;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

const DEFAULT_CLIENT_INFO: ClientInfo = { name: "agentpane", title: "agentpane", version: "0.0.0" };
const DEFAULT_SANDBOX: SandboxMode = "danger-full-access";
const DEFAULT_APPROVAL_POLICY: AskForApproval = "never";
const START_ABORTED_ERROR = "codex adapter start aborted: disposed during startup";
const TURN_START_ABORTED_ERROR = "codex adapter submit aborted: disposed during turn startup";
const TURN_START_PENDING_ERROR = "codex adapter cannot submit while turn/start is pending";
const TURN_ACTIVE_ERROR = "codex adapter cannot submit while a turn is active";

/** JSON-RPC "method not found"; used when a blocking request's kind has no handler. */
const UNSUPPORTED_REQUEST_CODE = -32601;

interface ClientOwnership {
	proc: CodexProcess;
	client: CodexClient | null;
	ready: boolean;
}

type TurnBusyState =
	| { source: "submission"; turnId: string | null }
	| { source: "lifecycle"; turnId: string };

export class CodexAdapter implements BackendAdapter {
	private currentRef: SessionRef;
	private options: CodexAdapterOptions;
	private reducer: CodexReducer;
	private readonly sandbox: SandboxMode;
	private readonly approvalPolicy: AskForApproval;

	private proc: CodexProcess | null = null;
	private client: CodexClient | null = null;
	private ownership: ClientOwnership | null = null;
	private threadId: string | null = null;
	/** A known-safe lifecycle id that `abort()` may interrupt. */
	private turnId: string | null = null;
	private turnStartPending = false;
	/**
	 * The single-flight admission gate. This is intentionally separate from
	 * `turnId`: a successful response can prove a submission is live without
	 * proving that its response id is safe to interrupt.
	 */
	private turnBusy: TurnBusyState | null = null;
	/**
	 * The latest current-thread turn candidate observed while the single allowed
	 * `turn/start` continuation can still resume. Keeping the latest candidate
	 * lets a response followed by its lifecycle in the same chunk retain the
	 * completion, while overflow still records that earlier ids made correlation
	 * ambiguous.
	 */
	private pendingTurnCompletions = new Map<string, "started" | "completed">();
	/** Candidate overflow makes an unknown response unsafe to install as active. */
	private pendingTurnCompletionOverflow = false;
	private model: string | null = null;
	private cwd: string | null = null;
	private disposed = false;
	private disposal: Promise<void> | null = null;

	/** Unique to this adapter lifetime, even when a stored thread is reopened. */
	private readonly requestNamespace = randomUUID();
	private nextExternalRequestId = 0;
	/** Opaque browser id -> the original typed app-server request. */
	private pendingRequests = new Map<
		string,
		{ id: RequestId; kind: string; wireKey: string }
	>();
	/** Typed app-server request key -> opaque browser id. */
	private externalRequestIds = new Map<string, string>();
	/** Turn ids in transcript order; `fork` needs the *previous* turn (see `fork`). */
	private turnOrder: string[] = [];

	private updateListeners = new Set<(state: AdapterState, changedIndex?: number) => void>();
	private requestListeners = new Set<(request: AgentRequest) => void>();
	private errorListeners = new Set<(message: string) => void>();

	constructor(ref: SessionRef, options: CodexAdapterOptions = {}) {
		this.currentRef = ref;
		this.options = options;
		this.reducer = new CodexReducer({ now: options.now });
		this.sandbox = options.sandbox ?? DEFAULT_SANDBOX;
		this.approvalPolicy = options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
	}

	/**
	 * The live session ref. A `virtual` session (D9) has no Codex thread id
	 * until `thread/start` returns, so this changes once during `start()`.
	 */
	get ref(): SessionRef {
		return this.currentRef;
	}

	// -- lifecycle ----------------------------------------------------------

	async start(opts: StartOptions): Promise<void> {
		if (this.disposed) throw new Error("codex adapter disposed");
		if (this.client) throw new Error("codex adapter already started");
		this.cwd = opts.cwd;
		if (opts.model) this.model = opts.model;

		const spawner = this.options.spawn ?? spawnCodex;
		const proc = spawner({ cwd: opts.cwd, env: this.options.env });
		this.proc = proc;
		const ownership: ClientOwnership = { proc, client: null, ready: false };
		this.ownership = ownership;
		const client = new CodexClient(proc, {
			onMessage: (msg) => {
				if (!this.owns(ownership)) return;
				this.onServerMessage(msg);
			},
			onExit: (code, signal, error) => {
				if (!this.owns(ownership)) return;
				this.emitError(
					error?.message ??
						`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
				);
			},
		});
		ownership.client = client;
		this.client = client;
		ownership.ready = true;
		const assertOwned = (): void => {
			if (!this.owns(ownership)) throw new Error(START_ABORTED_ERROR);
		};

		try {
			await client.request("initialize", {
				clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
				capabilities: null,
			});
			assertOwned();

			const started = opts.resumeId
				? await client.request<ThreadResumeResponse>("thread/resume", {
						threadId: opts.resumeId,
						cwd: opts.cwd,
						sandbox: this.sandbox,
						approvalPolicy: this.approvalPolicy,
						...(this.model ? { model: this.model } : {}),
					})
				: await client.request<ThreadStartResponse>("thread/start", {
						cwd: opts.cwd,
						sandbox: this.sandbox,
						approvalPolicy: this.approvalPolicy,
						...(this.model ? { model: this.model } : {}),
						...(this.options.ephemeral ? { ephemeral: true } : {}),
					});
			assertOwned();

			this.model = started.model ?? this.model;
			this.reducer.setIdentity({
				threadId: started.thread.id,
				model: started.model,
				modelProvider: started.modelProvider,
				reasoningEffort: started.reasoningEffort,
			});

			// `thread/resume` returns the thread's turns, so a reattach repaints
			// without a second round trip (D3's cold-start path).
			if (opts.resumeId && started.thread.turns?.length) {
				this.applyEffects(this.reducer.hydrate(started.thread));
				assertOwned();
				this.rememberTurns(started.thread);
			}

			assertOwned();
			this.threadId = started.thread.id;
			this.currentRef = { backend: "codex", id: started.thread.id };
		} catch (error) {
			client.dispose("codex adapter start failed");
			this.clearPendingRequests();
			if (this.ownership === ownership) {
				ownership.ready = false;
				this.ownership = null;
			}
			if (this.client === client) this.client = null;
			if (this.proc === proc) {
				this.proc = null;
				await proc.kill();
			}
			throw error;
		}
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		this.disposal = this.finishDisposal();
		return this.disposal;
	}

	private async finishDisposal(): Promise<void> {
		const client = this.client;
		const proc = this.proc;
		if (this.ownership) this.ownership.ready = false;
		this.ownership = null;
		this.client = null;
		this.proc = null;
		client?.dispose();
		this.updateListeners.clear();
		this.requestListeners.clear();
		this.errorListeners.clear();
		this.clearPendingRequests();
		this.turnId = null;
		this.turnStartPending = false;
		this.turnBusy = null;
		this.pendingTurnCompletions.clear();
		this.pendingTurnCompletionOverflow = false;
		await proc?.kill();
	}

	// -- driving a turn -----------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<void> {
		const client = this.requireClient();
		const threadId = this.requireThread();
		const ownership = this.ownership;
		if (!ownership || ownership.client !== client || !this.owns(ownership)) {
			throw new Error("codex adapter not started");
		}
		if (this.turnStartPending) throw new Error(TURN_START_PENDING_ERROR);
		const input: UserInput[] = [];
		if (text) input.push({ type: "text", text, text_elements: [] });
		for (const image of images ?? []) {
			input.push({ type: "image", url: `data:${image.mimeType};base64,${image.base64}` });
		}
		// D16: a prompt submitted mid-turn steers that turn. Verified live on
		// 2026-09-12 against codex-cli 0.154.0 (OW-tifuha, `docs/MANUAL_TESTING.md`):
		// `turn/steer` fired 29 deltas into a streaming turn returned that same
		// turn id, and the steered `userMessage` and the answering
		// `agentMessage` both arrived under it -- one `turn/completed`, no
		// second turn.
		//
		// `expectedTurnId` is a precondition app-server enforces, so this needs
		// a turn id it knows is live: `turnId` is exactly that, set only from an
		// unambiguously correlated id -- a `turn/started` notification, or a
		// `turn/start` response whose candidate nothing contradicts. A `turnBusy`
		// with no id is a submission the adapter cannot name, so there is nothing
		// to steer and the rejection stands.
		//
		// A compaction is the one live turn that must not be steered: `compact` is
		// one of the two `NonSteerableTurnKind`s, and a compaction runs as its own
		// turn (`resources/fixtures/codex/compact.jsonl` -- a `turn/started`
		// brackets the `contextCompaction` item), so `turnId` names a turn
		// app-server will refuse. The client disables Send while compaction is
		// showing, but a threshold compaction nobody asked for, a second client,
		// and `POST prompt` all reach here; without this the well-defined "busy"
		// becomes an opaque wire error, which is what `compact`'s own guard below
		// exists to prevent.
		if (this.turnId && !this.reducer.getState().compaction) {
			await client.request("turn/steer", { threadId, input, expectedTurnId: this.turnId });
			return;
		}
		if (this.turnBusy) throw new Error(TURN_ACTIVE_ERROR);
		this.turnStartPending = true;
		this.turnBusy = { source: "submission", turnId: null };
		let responseTurnId: string | undefined;
		let responseAccepted = false;
		try {
			const response = await client.request<TurnStartResponse>("turn/start", {
				threadId,
				input,
				// TurnStartParams.model overrides "for this turn and subsequent
				// turns" -- Codex has no standalone set-model request, so this is
				// where `setModel` takes effect.
				...(this.model ? { model: this.model } : {}),
			});
			if (ownership.client !== client || !this.owns(ownership)) {
				throw new Error(TURN_START_ABORTED_ERROR);
			}
			responseAccepted = true;
			responseTurnId = response.turn?.id;
			const completion = responseTurnId
				? this.pendingTurnCompletions.get(responseTurnId)
				: undefined;
			this.turnBusy = { source: "submission", turnId: responseTurnId ?? null };
			if (responseTurnId) {
				// Keep a lifecycle-established active id: a matching id is direct
				// evidence even after overflow, while a different id is authoritative.
				if (completion === "completed") {
					if (this.turnId === responseTurnId) this.turnId = null;
					this.turnBusy = null;
				} else if (
					this.turnId === null &&
					this.pendingTurnCompletions.size === 0 &&
					!this.pendingTurnCompletionOverflow
				) {
					this.turnId = responseTurnId;
				}
				// With no active id, a mismatched candidate or overflow leaves the
				// response untouched: it may name a submission steered into a turn that
				// already completed, so failing closed avoids reviving it.
			}
		} finally {
			if (ownership.client === client && this.owns(ownership)) {
				if (responseTurnId) this.pendingTurnCompletions.delete(responseTurnId);
				this.turnStartPending = false;
				this.pendingTurnCompletions.clear();
				this.pendingTurnCompletionOverflow = false;
				if (!responseAccepted) this.turnBusy = null;
				if (!this.turnBusy && this.turnId) {
					this.turnBusy = { source: "lifecycle", turnId: this.turnId };
				}
			}
		}
	}

	async abort(): Promise<void> {
		const client = this.requireClient();
		const turnId = this.turnId;
		if (!turnId) return;
		await client.request("turn/interrupt", { threadId: this.requireThread(), turnId });
	}

	/**
	 * Compact the thread's context via `thread/compact/start` (params
	 * `{ threadId }`, response an empty object -- OW-72, verified against
	 * codex-cli 0.147.0's generated schema).
	 *
	 * Refused while a turn is active, and it stays refused now that `submit()`
	 * steers instead (OW-tifuha): `compact` is one of the two
	 * `NonSteerableTurnKind`s, so there is no steering a compaction into a
	 * running turn, and app-server will not start a second turn while one runs.
	 * Admitting the request here only to have app-server reject it would turn a
	 * well-defined "busy" into an opaque wire error. The gate
	 * (`turnBusy`/`turnId`/`turnStartPending`) is the one `submit` used before
	 * it gained a steer path.
	 */
	async compact(): Promise<void> {
		const client = this.requireClient();
		const threadId = this.requireThread();
		if (this.turnStartPending) throw new Error(TURN_START_PENDING_ERROR);
		if (this.turnBusy || this.turnId) throw new Error(TURN_ACTIVE_ERROR);
		this.applyEffects(this.reducer.requestCompaction());
		try {
			await client.request("thread/compact/start", { threadId });
		} catch (error) {
			this.applyEffects(this.reducer.cancelCompaction());
			throw error;
		}
	}

	// -- fork-from-past -----------------------------------------------------

	/**
	 * One fork point per turn, labelled with that turn's user message.
	 *
	 * Codex forks at *turn* granularity (`ThreadForkParams.lastTurnId`), not at
	 * item granularity, so a fork point is a turn id even though the UI shows
	 * the user message inside it. `thread/rollback` -- DESIGN's other
	 * suggestion -- is marked DEPRECATED in the generated bindings and is not
	 * used here.
	 */
	async listForkPoints(): Promise<ForkPoint[]> {
		const client = this.requireClient();
		const read = await client.request<ThreadReadResponse>("thread/read", {
			threadId: this.requireThread(),
			includeTurns: true,
		});
		this.rememberTurns(read.thread);
		const points: ForkPoint[] = [];
		for (const turn of read.thread.turns ?? []) {
			const text = firstUserText(turn.items ?? []);
			if (text !== null) points.push({ id: turn.id, text });
		}
		return points;
	}

	async fork(entryId: string): Promise<SessionRef> {
		const client = this.requireClient();
		if (!this.turnOrder.length) await this.listForkPoints();
		const index = this.turnOrder.indexOf(entryId);
		if (index < 0) throw new Error(`unknown fork point: ${entryId}`);
		// `lastTurnId` is inclusive, so forking *at* a user message means
		// keeping everything through the turn before it.
		const lastTurnId = index > 0 ? this.turnOrder[index - 1] : undefined;
		// Both policies are spelled out because a fork inherits `approvalPolicy`
		// from its parent but NOT `sandbox`, which falls back to app-server's
		// `workspaceWrite` -- a silent downgrade from the thread being forked
		// (OW-18, D7a). Passing `approvalPolicy` too keeps the three
		// thread-creation paths reading alike rather than relying on that
		// asymmetry holding.
		const forked = await client.request<ThreadForkResponse>("thread/fork", {
			threadId: this.requireThread(),
			...(lastTurnId ? { lastTurnId } : {}),
			...(this.cwd ? { cwd: this.cwd } : {}),
			sandbox: this.sandbox,
			approvalPolicy: this.approvalPolicy,
			...(this.options.ephemeral ? { ephemeral: true } : {}),
		});
		return { backend: "codex", id: forked.thread.id };
	}

	// -- state --------------------------------------------------------------

	getState(): AdapterState {
		return { ...this.reducer.getState(), model: this.model };
	}

	onUpdate(cb: (state: AdapterState, changedIndex?: number) => void): Unsubscribe {
		this.updateListeners.add(cb);
		return () => this.updateListeners.delete(cb);
	}

	onRequest(cb: (request: AgentRequest) => void): Unsubscribe {
		this.requestListeners.add(cb);
		return () => this.requestListeners.delete(cb);
	}

	onError(cb: (message: string) => void): Unsubscribe {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	/**
	 * Answer a blocking `ServerRequest` (D2a). `null` declines, using the
	 * decision shape the method expects -- an approval answered with a JSON-RPC
	 * error would read as a client failure rather than a "no". Only kinds with
	 * such a shape are ever pending: `applyEffects` errors the rest out at
	 * arrival rather than publishing them.
	 */
	async reply(requestId: string, response: unknown): Promise<void> {
		const client = this.requireClient();
		const pending = this.pendingRequests.get(requestId);
		if (!pending) return; // already resolved, or never ours
		this.pendingRequests.delete(requestId);
		if (this.externalRequestIds.get(pending.wireKey) === requestId) {
			this.externalRequestIds.delete(pending.wireKey);
		}
		if (response === null || response === undefined) {
			client.respond(pending.id, DECLINE_RESPONSES[pending.kind]);
			return;
		}
		client.respond(pending.id, response);
	}

	// -- session controls ---------------------------------------------------

	/** Takes effect on the next `turn/start`; Codex has no standalone set-model call. */
	async setModel(model: string): Promise<void> {
		this.model = model;
		this.emitUpdate();
	}

	async listModels(): Promise<ModelInfo[]> {
		const client = this.requireClient();
		const models: ModelInfo[] = [];
		let cursor: string | null = null;
		// `model/list` paginates; the cap is a guard against a server that
		// keeps handing back a cursor.
		for (let page = 0; page < 20; page++) {
			const response: ModelListResponse = await client.request<ModelListResponse>("model/list", {
				...(cursor ? { cursor } : {}),
			});
			for (const model of response.data ?? []) {
				models.push({ id: model.id, label: model.displayName || model.id });
			}
			cursor = response.nextCursor ?? null;
			if (!cursor) break;
		}
		return models;
	}

	// -- internals ----------------------------------------------------------

	private onServerMessage(msg: CodexServerMessage): void {
		if ("method" in msg) {
			switch (msg.method) {
				case "turn/started": {
					if (msg.params.threadId !== this.threadId) return;
					const startedTurnId = msg.params.turn.id;
					this.turnId = startedTurnId;
					if (!this.turnStartPending) {
						if (!this.turnBusy || this.turnBusy.source === "lifecycle") {
							this.turnBusy = { source: "lifecycle", turnId: startedTurnId };
						} else if (this.turnBusy.turnId === null) {
							this.turnBusy = { source: "submission", turnId: startedTurnId };
						}
					}
					if (this.turnStartPending && !this.pendingTurnCompletions.has(startedTurnId)) {
						if (this.pendingTurnCompletions.size > 0) {
							// `turn/started` has no JSON-RPC request id. If another
							// same-thread producer exhausts the bounded candidate slots,
							// an unknown response might already have completed. Prefer a
							// no-op abort over reviving and interrupting that turn.
							this.pendingTurnCompletionOverflow = true;
						}
						this.pendingTurnCompletions.clear();
						this.pendingTurnCompletions.set(startedTurnId, "started");
					}
					break;
				}
				case "turn/completed": {
					if (msg.params.threadId !== this.threadId) return;
					const completedTurnId = msg.params.turn.id;
					if (this.pendingTurnCompletions.has(completedTurnId)) {
						this.pendingTurnCompletions.set(completedTurnId, "completed");
					}
					if (this.turnId === completedTurnId) this.turnId = null;
					if (!this.turnStartPending && this.turnBusy?.turnId === completedTurnId) {
						this.turnBusy = this.turnId
							? { source: "lifecycle", turnId: this.turnId }
							: null;
					}
					break;
				}
			}
		}
		this.applyEffects(this.reducer.handle(msg));
	}

	private applyEffects(effects: CodexEffect[]): void {
		for (const effect of effects) {
			switch (effect.type) {
				case "message":
					this.emitUpdate(effect.index);
					break;
				case "reset":
				case "streaming":
				case "compaction":
					this.emitUpdate(undefined);
					break;
				case "request": {
					// A kind with no entry in `DECLINE_RESPONSES` is one nothing here
					// can answer, and under D7a (`approvalPolicy: "never"`, with no
					// approval `ServerRequest` observed as of `codex-cli 0.154.0`)
					// nothing should be arriving at all -- so reaching this line means
					// a premise broke, most likely a newer app-server asking for
					// something new. This is not rudeness to a legitimate request: the
					// alternative is D2a's silent stall, a turn that blocks until the
					// session is killed, with no test and no log naming the cause.
					// Erroring out costs one turn and names the kind that did it.
					if (!Object.hasOwn(DECLINE_RESPONSES, effect.kind)) {
						this.requireClient().respondError(
							effect.requestId,
							UNSUPPORTED_REQUEST_CODE,
							`agentpane cannot answer ${effect.kind}`,
						);
						this.emitError(
							`codex sent an unsupported request (${effect.kind}); agentpane declined it`,
						);
						break;
					}
					const wireKey = wireRequestKey(effect.requestId);
					const previousExternalId = this.externalRequestIds.get(wireKey);
					if (previousExternalId) this.pendingRequests.delete(previousExternalId);
					const key = `codex:${this.requestNamespace}:${this.nextExternalRequestId++}`;
					this.pendingRequests.set(key, { id: effect.requestId, kind: effect.kind, wireKey });
					this.externalRequestIds.set(wireKey, key);
					const request: AgentRequest = {
						requestId: key,
						session: this.currentRef,
						kind: effect.kind,
						payload: effect.payload,
						...(effect.issuerThreadId ? { issuerThreadId: effect.issuerThreadId } : {}),
					};
					for (const listener of [...this.requestListeners]) listener(request);
					break;
				}
				case "request-resolved":
					// Codex resolved it without us (auto-approval, or another
					// client). Drop it so a late `reply` is a no-op.
					{
						const wireKey = wireRequestKey(effect.requestId);
						const externalId = this.externalRequestIds.get(wireKey);
						if (externalId) this.pendingRequests.delete(externalId);
						this.externalRequestIds.delete(wireKey);
					}
					break;
				case "error":
					this.emitError(effect.message);
					break;
			}
		}
	}

	private emitUpdate(changedIndex?: number): void {
		const state = this.getState();
		for (const listener of [...this.updateListeners]) listener(state, changedIndex);
	}

	private emitError(message: string): void {
		for (const listener of [...this.errorListeners]) listener(message);
	}

	private owns(ownership: ClientOwnership): boolean {
		return (
			!this.disposed &&
			ownership.ready &&
			this.ownership === ownership &&
			this.proc === ownership.proc &&
			this.client === ownership.client
		);
	}

	private clearPendingRequests(): void {
		this.pendingRequests.clear();
		this.externalRequestIds.clear();
	}

	private rememberTurns(thread: Pick<Thread, "turns">): void {
		this.turnOrder = (thread.turns ?? []).map((turn) => turn.id);
	}

	private requireClient(): CodexClient {
		if (!this.client) throw new Error("codex adapter not started");
		return this.client;
	}

	private requireThread(): string {
		if (!this.threadId) throw new Error("codex adapter has no thread");
		return this.threadId;
	}
}

/** The text of the first user message in a turn -- the fork point's label. */
function firstUserText(items: { type: string }[]): string | null {
	for (const item of items) {
		if (item.type !== "userMessage") continue;
		const content = (item as { content?: UserInput[] }).content ?? [];
		const text = content
			.filter((part): part is Extract<UserInput, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return text;
	}
	return null;
}

export class CodexAdapterFactory implements AdapterFactory {
	constructor(private readonly options: CodexAdapterOptions = {}) {}

	create(ref: SessionRef): BackendAdapter {
		if (ref.backend !== "codex") {
			throw new Error(`CodexAdapterFactory cannot create a "${ref.backend}" adapter`);
		}
		return new CodexAdapter(ref, this.options);
	}
}
