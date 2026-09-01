/**
 * `BackendAdapter` for Claude Code, driving `claude -p` over stream-json in
 * both directions (OW-beripo).
 *
 * This is the shell: spawn, control-channel correlation, and the
 * lifecycle/command surface. The event->message translation lives in
 * `reducer.ts`/`mapping.ts`, which this class drives and never second-guesses.
 *
 * Differences from the Codex shell that are protocol, not preference:
 *
 * - There is no request/response RPC for turns: a turn is admitted by writing
 *   a user-message line to stdin, and only the `result` event ends it. The
 *   CLI queues stdin messages sent mid-turn, so `submit()` does not gate.
 * - The session id is chosen by US at spawn (`--session-id`, settled live
 *   2026-08-25): a fresh session and a fork both know their id synchronously,
 *   so nothing waits on the `init` event (which only arrives with the first
 *   turn, not at spawn -- settled live the same day).
 * - `fork()` respawns THIS adapter's child onto the forked session
 *   (`--resume <id> --resume-session-at <entryId> --fork-session`), so like
 *   Pi -- and unlike Codex -- `adapter.ref` changes and the session manager's
 *   `#adoptRef` re-keys the table. The parent's store file is untouched and
 *   turns up in listings as a detached session; no lineage marker exists on
 *   disk (MANUAL_TESTING OW-mayuza).
 * - `onRequest` is inert: sbox's claude profile injects `bypassPermissions`,
 *   and the jail is the confinement boundary -- the same rationale DESIGN
 *   records for Codex's `danger-full-access`. The `can_use_tool` ask only
 *   exists under the undocumented `--permission-prompt-tool stdio` flag, which
 *   this adapter does not pass (shape recorded in fixture
 *   `permission-request.jsonl` for the later item).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRequest, ForkPoint, ModelInfo, SessionRef } from "../../../shared/protocol.ts";
import {
	claudePromptText,
	findClaudeSessionFile,
	readClaudeMessageEntries,
	type ClaudeStoreMessageEntry,
} from "../../sessions/claude.ts";
import type {
	AdapterState,
	AdapterFactory,
	BackendAdapter,
	ImageInput,
	StartOptions,
	Unsubscribe,
} from "../types.ts";
import { spawnClaude, type ClaudeProcess, type ClaudeSpawner } from "./process.ts";
import {
	buildControlRequestLine,
	buildUserMessageLine,
	isRecord,
	parseClaudeEventLine,
	type ClaudeEvent,
	type ClaudeModelDescriptor,
	type ClaudeUserContent,
} from "./protocol.ts";
import { ClaudeReducer, type ClaudeEffect } from "./reducer.ts";

/**
 * The fork-point id for "before the first message": there is no store entry
 * to name (`--resume-session-at` keeps the named entry, so forking before the
 * FIRST entry has nothing to keep), and `fork()` maps it to a fresh session
 * in the same workspace instead of a resume.
 */
export const CLAUDE_FORK_SESSION_START = "session-start";

const DEFAULT_CLAUDE_ROOT = join(homedir(), ".claude", "projects");

export interface ClaudeAdapterOptions {
	/** Injected in tests; the default spawns `direnv exec <cwd> sbox -- claude -p ...`. */
	spawn?: ClaudeSpawner;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Session-id mint, injectable so tests see deterministic refs. */
	newSessionId?: () => string;
	/**
	 * Store access for hydration and fork points, injectable so tests never
	 * touch `~/.claude`. The default locates
	 * `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` by filename match
	 * (the directory munging is lossy) and parses its message lines via
	 * `sessions/claude.ts`.
	 */
	readStoreEntries?: (sessionId: string) => Promise<ClaudeStoreMessageEntry[]>;
	/** Override the store root for the default reader. */
	claudeRoot?: string;
}

interface Ownership {
	proc: ClaudeProcess;
	live: boolean;
}

interface PendingControl {
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
}

export class ClaudeAdapter implements BackendAdapter {
	private currentRef: SessionRef;
	private readonly options: ClaudeAdapterOptions;
	private readonly reducer: ClaudeReducer;

	private ownership: Ownership | null = null;
	private cwd: string | null = null;
	private model: string | null = null;
	private started = false;
	private turnActive = false;
	private disposed = false;
	private disposal: Promise<void> | null = null;

	private controlSeq = 0;
	private readonly controlNamespace = randomUUID();
	private readonly pendingControls = new Map<string, PendingControl>();

	private updateListeners = new Set<(state: AdapterState, changedIndex?: number) => void>();
	private requestListeners = new Set<(request: AgentRequest) => void>();
	private errorListeners = new Set<(message: string) => void>();

	constructor(ref: SessionRef, options: ClaudeAdapterOptions = {}) {
		this.currentRef = ref;
		this.options = options;
		this.reducer = new ClaudeReducer({ now: options.now });
	}

	/** Changes during `start()` (a `virtual` id becomes the real one) and on `fork()`. */
	get ref(): SessionRef {
		return this.currentRef;
	}

	// -- lifecycle ----------------------------------------------------------

	async start(opts: StartOptions): Promise<void> {
		if (this.disposed) throw new Error("claude adapter disposed");
		if (this.started) throw new Error("claude adapter already started");
		this.started = true;
		this.cwd = opts.cwd;
		if (opts.model) this.model = opts.model;

		if (opts.resumeId) {
			// Cold start (D3): the stream will not replay history, so repaint from
			// the store file before spawning. The one await here is also the one
			// place a dispose can land before a child exists.
			const entries = await this.readStore(opts.resumeId);
			if (this.disposed) throw new Error("claude adapter start aborted: disposed during startup");
			this.applyEffects(this.reducer.hydrate(entries.map((entry) => entry.record)));
			this.currentRef = { backend: "claude", id: opts.resumeId };
			this.attachProcess({ cwd: opts.cwd, resumeId: opts.resumeId });
		} else {
			const sessionId = this.mintSessionId();
			this.currentRef = { backend: "claude", id: sessionId };
			this.attachProcess({ cwd: opts.cwd, sessionId });
		}
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		this.disposal = this.finishDisposal();
		return this.disposal;
	}

	private async finishDisposal(): Promise<void> {
		const ownership = this.ownership;
		this.ownership = null;
		if (ownership) ownership.live = false;
		this.updateListeners.clear();
		this.requestListeners.clear();
		this.errorListeners.clear();
		this.rejectPendingControls(new Error("claude adapter disposed"));
		await ownership?.proc.kill();
	}

	// -- driving a turn -----------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<void> {
		const proc = this.requireProc();
		const content: ClaudeUserContent[] = [];
		if (text) content.push({ type: "text", text });
		for (const image of images ?? []) {
			content.push({
				type: "image",
				source: { type: "base64", media_type: image.mimeType, data: image.base64 },
			});
		}
		// Admission is the stdin write; the CLI queues messages sent mid-turn.
		proc.write(JSON.stringify(buildUserMessageLine(content)));
		this.turnActive = true;
		this.applyEffects(this.reducer.beginTurn(text, images));
	}

	async abort(): Promise<void> {
		if (!this.turnActive) return;
		try {
			await this.sendControl({ subtype: "interrupt" });
		} catch {
			// "Not currently executing" and its kin: the goal state -- no running
			// turn -- already holds, so an errored interrupt is not a failure.
		}
	}

	/**
	 * `/compact` sent as a literal stream-json user message -- the CLI treats it
	 * as the slash command (OW-yilabe, fixture `compact.jsonl`). The reducer
	 * turns the resulting `compact_boundary` + summary into the marker.
	 */
	async compact(): Promise<void> {
		const proc = this.requireProc();
		this.applyEffects(this.reducer.requestCompaction());
		try {
			proc.write(JSON.stringify(buildUserMessageLine([{ type: "text", text: "/compact" }])));
			this.turnActive = true;
		} catch (error) {
			this.applyEffects(this.reducer.cancelCompaction());
			throw error;
		}
	}

	// -- fork-from-past -----------------------------------------------------

	/**
	 * One fork point per human prompt, labelled with that prompt's text -- the
	 * ordinal contract `controller.forkAndSubmit` indexes by. Truncation via
	 * `--resume-session-at` is INCLUSIVE of the named entry (OW-mayuza), so the
	 * point for "fork before prompt X" carries the uuid of the message entry
	 * PRECEDING X -- and the first prompt, which nothing precedes, carries
	 * `CLAUDE_FORK_SESSION_START`.
	 */
	async listForkPoints(): Promise<ForkPoint[]> {
		this.requireProc();
		const entries = await this.readStore(this.currentRef.id);
		const points: ForkPoint[] = [];
		let previousUuid: string | null = null;
		for (const entry of entries) {
			if (entry.type === "user") {
				const text = claudePromptText(entry.record);
				if (text !== null) {
					points.push({ id: previousUuid ?? CLAUDE_FORK_SESSION_START, text });
				}
			}
			previousUuid = entry.uuid;
		}
		return points;
	}

	/**
	 * Respawn this adapter's child onto a fork of the current session truncated
	 * inclusive of `entryId` (a store-line uuid), minting the forked session's
	 * id ourselves via `--session-id`. The ref changes; the manager re-keys.
	 */
	async fork(entryId: string): Promise<SessionRef> {
		const ownership = this.ownership;
		const cwd = this.cwd;
		if (!ownership || !cwd) throw new Error("claude adapter not started");
		const parentId = this.currentRef.id;
		const sessionId = this.mintSessionId();

		if (entryId === CLAUDE_FORK_SESSION_START) {
			// Nothing survives a cut before the first entry, so this is a fresh
			// session in the same workspace, not a resume.
			await this.replaceProcess(ownership, { cwd, sessionId });
			this.reducer.reset();
		} else {
			const entries = await this.readStore(parentId);
			const cut = entries.findIndex((entry) => entry.uuid === entryId);
			if (cut < 0) throw new Error(`unknown fork point: ${entryId}`);
			await this.replaceProcess(ownership, {
				cwd,
				resumeId: parentId,
				forkAtEntryId: entryId,
				sessionId,
			});
			// The fork's transcript is the parent's, truncated inclusive of the
			// cut -- exactly what the CLI keeps (OW-mayuza). Repaint from that.
			this.reducer.hydrate(entries.slice(0, cut + 1).map((entry) => entry.record));
		}
		this.turnActive = false;
		this.currentRef = { backend: "claude", id: sessionId };
		this.applyEffects([{ type: "reset" }]);
		return this.currentRef;
	}

	// -- state --------------------------------------------------------------

	getState(): AdapterState {
		return this.reducer.getState();
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

	/** Inert: nothing fires `onRequest` under sbox's bypassPermissions (see module doc). */
	async reply(_requestId: string, _response: unknown): Promise<void> {}

	// -- session controls ---------------------------------------------------

	async setModel(model: string): Promise<void> {
		await this.sendControl({ subtype: "set_model", model });
		// Only on success (a bogus id rejects above): remembered so a fork's
		// respawn keeps it.
		this.model = model;
	}

	/**
	 * The `initialize` control response carries the model list (the `init`
	 * event does not). It also carries the operator's account email -- never
	 * record this response in a fixture (OW-yilabe).
	 */
	async listModels(): Promise<ModelInfo[]> {
		const response = await this.sendControl({ subtype: "initialize" });
		const models = isRecord(response) && Array.isArray(response.models) ? response.models : [];
		const out: ModelInfo[] = [];
		for (const model of models as ClaudeModelDescriptor[]) {
			if (typeof model?.value !== "string") continue;
			out.push({ id: model.value, label: model.displayName || model.value });
		}
		return out;
	}

	// -- internals ----------------------------------------------------------

	private mintSessionId(): string {
		return this.options.newSessionId?.() ?? randomUUID();
	}

	private readStore(sessionId: string): Promise<ClaudeStoreMessageEntry[]> {
		if (this.options.readStoreEntries) return this.options.readStoreEntries(sessionId);
		return defaultReadStoreEntries(this.options.claudeRoot ?? DEFAULT_CLAUDE_ROOT, sessionId);
	}

	private attachProcess(spawnOpts: {
		cwd: string;
		resumeId?: string;
		sessionId?: string;
		forkAtEntryId?: string;
	}): void {
		const spawner = this.options.spawn ?? spawnClaude;
		const proc = spawner({
			...spawnOpts,
			...(this.model ? { model: this.model } : {}),
			...(this.options.env ? { env: this.options.env } : {}),
		});
		const ownership: Ownership = { proc, live: true };
		this.ownership = ownership;
		proc.onLine((line) => {
			if (!ownership.live) return;
			this.handleLine(line);
		});
		proc.onExit((code, signal, error) => {
			if (!ownership.live) return;
			this.turnActive = false;
			this.rejectPendingControls(
				error ?? new Error(`claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
			);
			this.emitError(
				error?.message ?? `claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			);
		});
	}

	/** Swap the child under this adapter (fork): retire the old one first. */
	private async replaceProcess(
		previous: Ownership,
		spawnOpts: { cwd: string; resumeId?: string; sessionId?: string; forkAtEntryId?: string },
	): Promise<void> {
		previous.live = false;
		this.rejectPendingControls(new Error("claude adapter forked; control channel replaced"));
		await previous.proc.kill();
		if (this.disposed) throw new Error("claude adapter disposed");
		this.attachProcess(spawnOpts);
	}

	private handleLine(line: string): void {
		const event = parseClaudeEventLine(line);
		if (!event) return;
		if (event.type === "control_response") {
			this.handleControlResponse(event);
			return;
		}
		if (event.type === "system" && event.subtype === "init") {
			const sessionId = (event as { session_id?: unknown }).session_id;
			// `--session-id`/`--resume` make this a confirmation, but the CLI is
			// authoritative about its own store.
			if (typeof sessionId === "string" && sessionId && sessionId !== this.currentRef.id) {
				this.currentRef = { backend: "claude", id: sessionId };
			}
		}
		if (event.type === "result") this.turnActive = false;
		this.applyEffects(this.reducer.handle(event));
	}

	private handleControlResponse(event: Extract<ClaudeEvent, { type: "control_response" }>): void {
		const response = event.response;
		const requestId = typeof response?.request_id === "string" ? response.request_id : null;
		if (!requestId) return;
		const pending = this.pendingControls.get(requestId);
		if (!pending) return;
		this.pendingControls.delete(requestId);
		if (response?.subtype === "error") {
			pending.reject(new Error(response.error ?? "claude control request failed"));
		} else {
			pending.resolve(response?.response);
		}
	}

	private sendControl(request: { subtype: string } & Record<string, unknown>): Promise<unknown> {
		const proc = this.requireProc();
		const requestId = `agentpane:${this.controlNamespace}:${this.controlSeq++}`;
		return new Promise((resolve, reject) => {
			this.pendingControls.set(requestId, { resolve, reject });
			try {
				proc.write(JSON.stringify(buildControlRequestLine(requestId, request)));
			} catch (error) {
				this.pendingControls.delete(requestId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private rejectPendingControls(error: Error): void {
		const pending = [...this.pendingControls.values()];
		this.pendingControls.clear();
		for (const control of pending) control.reject(error);
	}

	private applyEffects(effects: ClaudeEffect[]): void {
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

	private requireProc(): ClaudeProcess {
		if (!this.ownership?.live) throw new Error("claude adapter not started");
		return this.ownership.proc;
	}
}

async function defaultReadStoreEntries(
	root: string,
	sessionId: string,
): Promise<ClaudeStoreMessageEntry[]> {
	const file = await findClaudeSessionFile(root, sessionId);
	if (!file) throw new Error(`no Claude Code store file for session ${sessionId}`);
	return readClaudeMessageEntries(file);
}

export class ClaudeAdapterFactory implements AdapterFactory {
	constructor(private readonly options: ClaudeAdapterOptions = {}) {}

	create(ref: SessionRef): BackendAdapter {
		if (ref.backend !== "claude") {
			throw new Error(`ClaudeAdapterFactory cannot create a "${ref.backend}" adapter`);
		}
		return new ClaudeAdapter(ref, this.options);
	}
}
