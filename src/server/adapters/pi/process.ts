/**
 * The Pi process shell: spawning, stdio, command/response correlation, and
 * lifecycle. Delegates all message assembly to `reducer.ts` and all framing
 * to `framing.ts` -- this file should never need to parse a delta itself.
 *
 * Spawning goes through the injectable `PiSpawn` seam rather than calling
 * `node:child_process.spawn` directly, so `process.test.ts` can drive the
 * whole shell -- correlation, framing, lifecycle, teardown -- over a scripted
 * fake child with no subprocess and no live model. The default is the real
 * `spawn`, so production callers pass nothing.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { Model } from "@earendil-works/pi-ai";
import type {
	AdapterState,
	BackendAdapter,
	ImageInput,
	StartOptions,
	Unsubscribe,
} from "../types.ts";
import type { AgentRequest, ForkPoint, ModelInfo, SessionRef } from "../../../shared/protocol.ts";
import { LfLineSplitter } from "./framing.ts";
import {
	buildUiReplyCommand,
	createInitialPiState,
	type PiReducerState,
	reducePiNotification,
} from "./reducer.ts";
import { buildPiSpawnCommand } from "./spawn.ts";
import {
	modelToInfo,
	type PiCommand,
	type PiOutputLine,
	type PiResponseFor,
	splitModelRef,
} from "./protocol.ts";

type UpdateListener = (state: AdapterState, changedIndex?: number) => void;
type RequestListener = (request: AgentRequest) => void;
type ErrorListener = (message: string) => void;

interface PendingCommand {
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// The spawn seam
//
// Structural subsets of the Node types, covering only what this adapter
// touches. A real `ChildProcessWithoutNullStreams` satisfies them, so the
// default spawn needs no cast; a test fake needs no `node:child_process`.
// `any[]` in the listener signature is deliberate -- `unknown[]` would make
// concretely-typed handlers like `(chunk: string) => void` unassignable.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: see note above
type Listener = (...args: any[]) => void;

export interface PiReadable {
	setEncoding(encoding: "utf8"): unknown;
	on(event: string, listener: Listener): unknown;
}

export interface PiWritable {
	readonly destroyed: boolean;
	write(chunk: string): unknown;
	end(): unknown;
}

export interface PiChild {
	readonly stdout: PiReadable;
	readonly stderr: PiReadable;
	readonly stdin: PiWritable;
	on(event: string, listener: Listener): unknown;
	kill(): unknown;
}

export type PiSpawn = (command: string, args: string[], options: { cwd: string }) => PiChild;

export interface PiAdapterDeps {
	/** Defaults to `node:child_process.spawn`. Injected by tests. */
	spawn?: PiSpawn;
}

/**
 * How much of Pi's stderr to retain for the death report. Bounded because a
 * chatty extension could otherwise grow this without limit over a long
 * session.
 */
const STDERR_TAIL_LIMIT = 8_192;

export class PiAdapter implements BackendAdapter {
	readonly ref: SessionRef;

	private readonly spawn: PiSpawn;
	private child?: PiChild;
	private readonly splitter = new LfLineSplitter();
	private state: PiReducerState = createInitialPiState();
	private disposed = false;
	/** Set once the child is gone; makes teardown idempotent and writes fail loudly. */
	private closed = false;
	/** Populated by the `error` event, which on a failed spawn is the only account of why. */
	private spawnError?: string;
	private stderrTail = "";

	private readonly updateListeners = new Set<UpdateListener>();
	private readonly requestListeners = new Set<RequestListener>();
	private readonly errorListeners = new Set<ErrorListener>();

	private readonly pendingCommands = new Map<string, PendingCommand>();
	private nextCommandId = 0;

	constructor(ref: SessionRef, deps: PiAdapterDeps = {}) {
		this.ref = ref;
		this.spawn = deps.spawn ?? nodeSpawn;
	}

	// -- lifecycle ------------------------------------------------------------

	async start(opts: StartOptions): Promise<void> {
		const { command, args, cwd } = buildPiSpawnCommand({
			cwd: opts.cwd,
			resumeId: opts.resumeId,
			model: opts.model,
		});

		const child = this.spawn(command, args, { cwd });
		this.child = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));
		child.stdout.on("end", () => this.handleStreamEnd());

		// stderr is diagnostics, not protocol, and not per-chunk errors. Both
		// wrappers in the spawn chain write routine chatter here -- direnv
		// announces every `.envrc` it loads on stderr (verified), and sbox/bwrap
		// add their own -- so raising each chunk through `onError` would put a
		// red banner in the UI on a perfectly healthy start. `onError`'s frozen
		// contract is "a turn failed in a way the transcript does not convey",
		// which this is not. Retain a bounded tail instead and spend it on the
		// death report, where it is the only clue to why the process died.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
		});

		child.on("error", (err: Error) => {
			this.spawnError = `Failed to spawn Pi (${command}): ${err.message}`;
		});
		// `close`, not `exit`: on a spawn failure (ENOENT -- `direnv` or `sbox`
		// missing from PATH) Node emits `error` and `close` but NEVER `exit`,
		// verified on this machine. Binding only `exit` meant a failed spawn
		// left the `get_state` probe below pending forever, so `start()` hung
		// rather than rejecting. `close` also fires strictly after stdio drains,
		// so it cannot reject a command whose response is still in the pipe.
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => this.handleClose(code, signal));

		// Readiness probe: pipane's process pool found spawning alone isn't
		// enough to know the process can accept commands (it used to poll with
		// a raw setTimeout before switching to a get_state round trip -- see
		// HANDOFF's pipane references). Round-tripping get_state here is the
		// same fix: `start()` doesn't resolve until Pi has actually answered.
		await this.sendCommand<PiResponseFor<"get_state">>({ type: "get_state" });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const pending of this.pendingCommands.values()) {
			pending.reject(new Error("Pi adapter disposed"));
		}
		this.pendingCommands.clear();
		if (this.child) {
			this.child.stdin.end();
			this.child.kill();
		}
	}

	// -- driving a turn ---------------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<void> {
		const cmd: PiCommand = {
			type: "prompt",
			message: text,
			images: images?.map((i) => ({ type: "image" as const, data: i.base64, mimeType: i.mimeType })),
			// rpc.md: a `prompt` sent while already streaming is rejected unless
			// `streamingBehavior` is set. "steer" (deliver after the current tool
			// batch) is Pi's own default interactive behavior for a message typed
			// mid-turn, so that's what an adapter-level `submit()` -- which has no
			// way for the caller to express steer-vs-follow-up -- should pick.
			...(this.state.isStreaming ? { streamingBehavior: "steer" as const } : {}),
		};
		await this.sendCommand<PiResponseFor<"prompt">>(cmd);
	}

	async abort(): Promise<void> {
		await this.sendCommand<PiResponseFor<"abort">>({ type: "abort" });
	}

	// -- fork-from-past -----------------------------------------------------

	async listForkPoints(): Promise<ForkPoint[]> {
		const resp = await this.sendCommand<PiResponseFor<"get_fork_messages">>({ type: "get_fork_messages" });
		return resp.data.messages.map((m) => ({ id: m.entryId, text: m.text }));
	}

	async fork(entryId: string): Promise<SessionRef> {
		const forked = await this.sendCommand<PiResponseFor<"fork">>({ type: "fork", entryId });
		// A `session_before_fork` extension handler can veto the fork, and Pi
		// reports that as `success: true` with `data.cancelled: true` (rpc.md,
		// "fork") -- not as an error response. Taken at face value that reads as
		// a successful fork, and we would refetch an unchanged transcript and
		// tell the caller the rewind happened. Surface the veto instead.
		if (forked.data.cancelled) {
			throw new Error(`Pi fork from entry "${entryId}" was cancelled by an extension`);
		}
		// Pi's `fork` rewinds the active branch of the SAME session file in
		// place (unlike Codex's `thread/fork`, which mints a new thread id --
		// see rpc.md's `fork` vs `clone`, and this workstream's report). It
		// emits no message events of its own, so our held transcript is now
		// stale; re-fetch it wholesale. `changedIndex` omitted on purpose --
		// this touches the whole transcript, not one tail message (D3).
		const resp = await this.sendCommand<PiResponseFor<"get_messages">>({ type: "get_messages" });
		this.state = { ...this.state, messages: resp.data.messages, isStreaming: false };
		this.emitUpdate(undefined);
		return this.ref;
	}

	// -- state ----------------------------------------------------------------

	getState(): AdapterState {
		return { messages: this.state.messages, isStreaming: this.state.isStreaming };
	}

	onUpdate(cb: UpdateListener): Unsubscribe {
		this.updateListeners.add(cb);
		return () => this.updateListeners.delete(cb);
	}

	onRequest(cb: RequestListener): Unsubscribe {
		this.requestListeners.add(cb);
		return () => this.requestListeners.delete(cb);
	}

	async reply(requestId: string, response: unknown): Promise<void> {
		const method = this.state.pendingUiRequests[requestId];
		if (!method) {
			throw new Error(`No pending Pi UI request with id "${requestId}"`);
		}
		const { [requestId]: _removed, ...rest } = this.state.pendingUiRequests;
		this.state = { ...this.state, pendingUiRequests: rest };
		this.writeLine(buildUiReplyCommand(method, requestId, response));
	}

	onError(cb: ErrorListener): Unsubscribe {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	// -- session controls -----------------------------------------------------

	async setModel(model: string): Promise<void> {
		const { provider, modelId } = splitModelRef(model);
		await this.sendCommand<PiResponseFor<"set_model">>({ type: "set_model", provider, modelId });
	}

	async listModels(): Promise<ModelInfo[]> {
		const resp = await this.sendCommand<PiResponseFor<"get_available_models">>({ type: "get_available_models" });
		return resp.data.models.map((m: Model<any>) => modelToInfo(m));
	}

	// -- stdio plumbing ---------------------------------------------------------

	private handleChunk(chunk: string): void {
		for (const line of this.splitter.push(chunk)) this.handleLine(line);
	}

	private handleStreamEnd(): void {
		for (const line of this.splitter.flush()) this.handleLine(line);
	}

	private handleLine(line: string): void {
		if (line.trim() === "") return;
		let parsed: PiOutputLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.emitError(`Pi emitted a non-JSON line: ${line.slice(0, 200)}`);
			return;
		}

		if (parsed.type === "response") {
			this.handleResponse(parsed);
			return;
		}

		const result = reducePiNotification(this.state, parsed);
		const changed = result.state !== this.state;
		this.state = result.state;
		if (changed) this.emitUpdate(result.changedIndex);
		if (result.request) {
			this.emitRequest({ session: this.ref, ...result.request });
		}
		if (result.error) this.emitError(result.error);
	}

	private handleResponse(resp: Extract<PiOutputLine, { type: "response" }>): void {
		const id = resp.id;
		const pending = id ? this.pendingCommands.get(id) : undefined;
		if (pending) {
			this.pendingCommands.delete(id as string);
			if (resp.success) pending.resolve(resp);
			else pending.reject(new Error(resp.error));
			return;
		}
		if (!resp.success) {
			this.emitError(`Pi command "${resp.command}" failed: ${resp.error}`);
		}
	}

	private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.closed) return;
		this.closed = true;

		// On a failed spawn the exit code is meaningless (-2 for ENOENT), so the
		// `error` event's account wins when we have one.
		const reason = this.spawnError ?? `Pi process exited (code=${code}, signal=${signal})`;
		const detail = this.stderrTail.trim();
		const message = detail ? `${reason}\n${detail}` : reason;

		for (const pending of this.pendingCommands.values()) {
			pending.reject(new Error(`${message} before responding`));
		}
		this.pendingCommands.clear();

		if (this.state.isStreaming) {
			this.state = { ...this.state, isStreaming: false };
			this.emitUpdate(undefined);
		}
		// A disposed adapter closing is the expected end of its life, not news.
		if (!this.disposed) this.emitError(message);
	}

	private sendCommand<R>(cmd: PiCommand): Promise<R> {
		return new Promise((resolve, reject) => {
			const id = `c${this.nextCommandId++}`;
			this.pendingCommands.set(id, { resolve: resolve as (r: unknown) => void, reject });
			try {
				this.writeLine({ ...cmd, id });
			} catch (err) {
				this.pendingCommands.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private writeLine(obj: unknown): void {
		// `stdin.destroyed` alone is not enough: `end()` only flips it once the
		// stream finishes, so a command issued right after `dispose()` would
		// otherwise be written into a pipe nobody is reading and then hang
		// waiting for a response that cannot come.
		if (!this.child || this.disposed || this.closed || this.child.stdin.destroyed) {
			throw new Error("Pi process is not running");
		}
		this.child.stdin.write(`${JSON.stringify(obj)}\n`);
	}

	private emitUpdate(changedIndex?: number): void {
		const snapshot: AdapterState = { messages: this.state.messages, isStreaming: this.state.isStreaming };
		for (const cb of this.updateListeners) cb(snapshot, changedIndex);
	}

	private emitRequest(request: AgentRequest): void {
		for (const cb of this.requestListeners) cb(request);
	}

	private emitError(message: string): void {
		for (const cb of this.errorListeners) cb(message);
	}
}
