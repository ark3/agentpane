/**
 * `BackendAdapter` for Codex.
 *
 * This is the shell: spawn, JSON-RPC, and the lifecycle/command surface. All
 * of the item->message translation lives in `reducer.ts` / `mapping.ts`, which
 * this class drives and never second-guesses. The split is what lets the hard
 * half be tested against recorded fixtures with no subprocess at all.
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
	type ClientInfo,
	type CodexServerMessage,
	type ModelListResponse,
	type RequestId,
	type Thread,
	type ThreadForkResponse,
	type ThreadReadResponse,
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
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

const DEFAULT_CLIENT_INFO: ClientInfo = { name: "agentpane", title: "agentpane", version: "0.0.0" };
const START_ABORTED_ERROR = "codex adapter start aborted: disposed during startup";

/** JSON-RPC "request cancelled"; used when a blocking request is declined. */
const DECLINED_CODE = -32800;

interface ClientOwnership {
	proc: CodexProcess;
	client: CodexClient | null;
	ready: boolean;
}

export class CodexAdapter implements BackendAdapter {
	private currentRef: SessionRef;
	private options: CodexAdapterOptions;
	private reducer: CodexReducer;

	private proc: CodexProcess | null = null;
	private client: CodexClient | null = null;
	private ownership: ClientOwnership | null = null;
	private threadId: string | null = null;
	private turnId: string | null = null;
	private pendingTurnStarts = 0;
	private completedTurnIds = new Set<string>();
	private model: string | null = null;
	private cwd: string | null = null;
	private disposed = false;

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
				? await client.request<ThreadStartResponse>("thread/resume", {
						threadId: opts.resumeId,
						cwd: opts.cwd,
						...(this.model ? { model: this.model } : {}),
					})
				: await client.request<ThreadStartResponse>("thread/start", {
						cwd: opts.cwd,
						...(this.model ? { model: this.model } : {}),
						...(this.options.ephemeral ? { ephemeral: true } : {}),
					});
			assertOwned();

			this.model = started.model ?? this.model;
			this.reducer.setIdentity({ model: started.model, modelProvider: started.modelProvider });

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
				proc.kill();
			}
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const client = this.client;
		const proc = this.proc;
		if (this.ownership) this.ownership.ready = false;
		this.ownership = null;
		this.client = null;
		this.proc = null;
		client?.dispose();
		proc?.kill();
		this.updateListeners.clear();
		this.requestListeners.clear();
		this.errorListeners.clear();
		this.clearPendingRequests();
		this.completedTurnIds.clear();
	}

	// -- driving a turn -----------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<void> {
		const client = this.requireClient();
		const threadId = this.requireThread();
		const input: UserInput[] = [];
		if (text) input.push({ type: "text", text, text_elements: [] });
		for (const image of images ?? []) {
			input.push({ type: "image", url: `data:${image.mimeType};base64,${image.base64}` });
		}
		// Once a new turn is requested, the previous turn is no longer an abort
		// target. A response or `turn/started` notification installs the new id.
		this.turnId = null;
		this.pendingTurnStarts += 1;
		let responseTurnId: string | undefined;
		try {
			const response = await client.request<TurnStartResponse>("turn/start", {
				threadId,
				input,
				// TurnStartParams.model overrides "for this turn and subsequent
				// turns" -- Codex has no standalone set-model request, so this is
				// where `setModel` takes effect.
				...(this.model ? { model: this.model } : {}),
			});
			responseTurnId = response.turn?.id;
			this.turnId =
				responseTurnId && !this.completedTurnIds.has(responseTurnId) ? responseTurnId : null;
		} finally {
			if (responseTurnId) this.completedTurnIds.delete(responseTurnId);
			this.pendingTurnStarts -= 1;
			if (this.pendingTurnStarts === 0) this.completedTurnIds.clear();
		}
	}

	async abort(): Promise<void> {
		const client = this.requireClient();
		const turnId = this.turnId;
		if (!turnId) return;
		await client.request("turn/interrupt", { threadId: this.requireThread(), turnId });
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
		const forked = await client.request<ThreadForkResponse>("thread/fork", {
			threadId: this.requireThread(),
			...(lastTurnId ? { lastTurnId } : {}),
			...(this.cwd ? { cwd: this.cwd } : {}),
			...(this.options.ephemeral ? { ephemeral: true } : {}),
		});
		return { backend: "codex", id: forked.thread.id };
	}

	// -- state --------------------------------------------------------------

	getState(): AdapterState {
		const { messages, isStreaming } = this.reducer.getState();
		return { messages, isStreaming };
	}

	getMessages(): AgentMessage[] {
		return this.reducer.getState().messages;
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
	 * decision shape the method expects where we know one -- an approval
	 * answered with a JSON-RPC error would read as a client failure rather
	 * than a "no".
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
			const decline = DECLINE_RESPONSES[pending.kind];
			if (decline !== undefined) client.respond(pending.id, decline);
			else client.respondError(pending.id, DECLINED_CODE, "declined by user");
			return;
		}
		client.respond(pending.id, response);
	}

	// -- session controls ---------------------------------------------------

	/** Takes effect on the next `turn/start`; Codex has no standalone set-model call. */
	async setModel(model: string): Promise<void> {
		this.model = model;
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
				case "turn/started":
					this.turnId = msg.params.turn.id;
					break;
				case "turn/completed":
					if (this.pendingTurnStarts > 0) this.completedTurnIds.add(msg.params.turn.id);
					if (this.turnId === msg.params.turn.id) this.turnId = null;
					break;
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
					this.emitUpdate(undefined);
					break;
				case "request": {
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
