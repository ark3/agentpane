/**
 * The Pi process shell: spawning, stdio, command/response correlation, and
 * lifecycle. Delegates all message assembly to `reducer.ts` and all framing
 * to `framing.ts` -- this file should never need to parse a delta itself.
 *
 * Not exercised by fixture-driven tests (no live subprocess in the test
 * suite, per WORKSTREAMS.md); `reducer.ts` and `spawn.ts` carry the tested
 * logic, this file wires it to a real child process.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

export class PiAdapter implements BackendAdapter {
	readonly ref: SessionRef;

	private child?: ChildProcessWithoutNullStreams;
	private readonly splitter = new LfLineSplitter();
	private state: PiReducerState = createInitialPiState();
	private disposed = false;

	private readonly updateListeners = new Set<UpdateListener>();
	private readonly requestListeners = new Set<RequestListener>();
	private readonly errorListeners = new Set<ErrorListener>();

	private readonly pendingCommands = new Map<string, PendingCommand>();
	private nextCommandId = 0;

	constructor(ref: SessionRef) {
		this.ref = ref;
	}

	// -- lifecycle ------------------------------------------------------------

	async start(opts: StartOptions): Promise<void> {
		const { command, args, cwd } = buildPiSpawnCommand({
			cwd: opts.cwd,
			resumeId: opts.resumeId,
			model: opts.model,
		});

		const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));
		child.stdout.on("end", () => this.handleStreamEnd());

		// Pi's own stderr is diagnostic noise (extension load errors, etc.), not
		// part of the RPC protocol -- surface it as an adapter error rather than
		// silently dropping it, but don't try to parse it.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			const text = chunk.trim();
			if (text) this.emitError(`Pi stderr: ${text}`);
		});

		child.on("error", (err) => this.emitError(`Failed to spawn Pi: ${err.message}`));
		child.on("exit", (code, signal) => this.handleExit(code, signal));

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
		await this.sendCommand<PiResponseFor<"fork">>({ type: "fork", entryId });
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

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		for (const pending of this.pendingCommands.values()) {
			pending.reject(new Error(`Pi process exited (code=${code}, signal=${signal}) before responding`));
		}
		this.pendingCommands.clear();
		if (this.state.isStreaming) {
			this.state = { ...this.state, isStreaming: false };
			this.emitUpdate(undefined);
		}
		if (!this.disposed) {
			this.emitError(`Pi process exited unexpectedly (code=${code}, signal=${signal})`);
		}
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
		if (!this.child || this.child.stdin.destroyed) {
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
