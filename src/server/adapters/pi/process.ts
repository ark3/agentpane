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
import {
	type AdapterState,
	type BackendAdapter,
	BackendRefusedError,
	type ForkResult,
	type ImageInput,
	type StartOptions,
	type Unsubscribe,
} from "../types.ts";
import type { AgentRequest, ForkPoint, ModelInfo, SessionRef } from "../../../shared/protocol.ts";
import { LfLineSplitter } from "./framing.ts";
import {
	buildUiReplyCommand,
	createInitialPiState,
	type PiReducerState,
	reducePiNotification,
	withLoadedEfforts,
} from "./reducer.ts";
import { buildPiSpawnCommand } from "./spawn.ts";
import {
	modelRefusal,
	modelToInfo,
	type PiCommand,
	type PiOutputLine,
	type PiResponseFor,
	splitModelRef,
	thinkingLevels,
} from "./protocol.ts";

type UpdateListener = (state: AdapterState, changedIndex?: number) => void;
type RequestListener = (request: AgentRequest) => void;
type ErrorListener = (message: string) => void;

interface PendingCommand {
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
}

/** Pi answered `success: false`: it is alive and said no, unlike a pipe or process failure. */
class PiCommandError extends Error {}

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
	kill(signal?: NodeJS.Signals): unknown;
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
/** Matches the Codex and Claude process shells, so every backend dies on the same schedule. */
const TERMINATE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;

export class PiAdapter implements BackendAdapter {
	/**
	 * Pi's session id *is* its JSONL path (D9), and for a `virtual` session Pi
	 * chooses that path itself. So `ref` is not stable at construction: it
	 * holds whatever the caller named the session until Pi reports the real
	 * `sessionFile`, at which point it is adopted. As of `pi 0.87.1` Pi names
	 * the path from `start()`'s `get_state`, though it writes no file there
	 * until the first turn's reply ends (MANUAL_TESTING OW-bohodu).
	 *
	 * For the server: **re-read `adapter.ref` after `start()` and after the
	 * first `submit()` resolves.** Those are the two points at which it can
	 * change, both are awaited, and a session keyed by the id it was created
	 * with will not be findable on disk afterwards.
	 */
	get ref(): SessionRef {
		return this.sessionRef;
	}
	private sessionRef: SessionRef;
	/**
	 * False until Pi has told us the session's real file. On `pi 0.84.1`,
	 * `0.85.1` and `0.87.1` a fresh session's is named at start (HANDOFF finding
	 * 41, MANUAL_TESTING OW-bohodu), but a Pi that names none there leaves this
	 * false across `start()`, to resolve after the first turn.
	 */
	private idResolved = false;

	private readonly spawn: PiSpawn;
	private child?: PiChild;
	private readonly splitter = new LfLineSplitter();
	private state: PiReducerState = createInitialPiState();
	private model: string | null = null;
	/**
	 * Pi's thinking level is the effort (OW-ruzuhu). It is read, not assumed:
	 * `get_state` names it at start and after a fork, and Pi announces every
	 * change with `thinking_level_changed`, including the ones it makes itself.
	 * The reducer's `effort` is this level while the model reasons, and null
	 * while it does not, since Pi pins such a model at `off` and there is
	 * nothing to show or choose.
	 *
	 * Offered per model from the catalogue entry, not from
	 * `get_available_thinking_levels`, which answers for the current model only
	 * (`thinkingLevels` in `protocol.ts`). `defaultEffort` is null: what Pi picks
	 * for a model is `settings.json`'s `modelThinkingLevels` entry, else its
	 * `defaultThinkingLevel`, else the level already in force, clamped to the
	 * model -- none of which the catalogue carries.
	 *
	 * `chosenEffort` is re-sent after a model change, because `set_model` puts
	 * the level back to that settings default when one exists. Measured on the
	 * home server, 2026-09-23, `pi 0.87.1` (docs/MANUAL_TESTING.md, OW-ruzuhu):
	 * with `modelThinkingLevels` naming `high`, `off` became `high` again across
	 * a `set_model` to the same model; with neither setting, `off` survived it.
	 * And a `set_thinking_level` sent while `set_model` is still in flight can
	 * land first and then be undone: as read at the source on 0.87.1, not run,
	 * `rpc-mode.js` does not wait for one command before starting the next, and
	 * `set_model` awaits an auth check before it resets the level. A client
	 * sending both at once, as the Emacs one does, would hit that.
	 * A choice the new model does not list is dropped, and Pi's own clamp
	 * stands, as Codex falls back to the new model's default.
	 *
	 * A resumed session runs at the level its file last recorded, not at the
	 * settings default. Same run: a session that chose `off` was resumed with
	 * `--session` alone while `settings.json` named `max` for the model and
	 * `low` as the default, and `get_state` read `off`; `--model` without a
	 * suffix kept `off` too, but `--model ...:high` read `high`, so a resume
	 * spawn that carries the suffix overrides the session's own level. So the
	 * `get_state` at start is the truth here too, and no choice is resent.
	 *
	 * Which turns carry a level: every assistant turn, live or loaded. A live
	 * one is named at `message_start`. One loaded by `get_messages` -- the whole
	 * transcript on a resume, and again after a fork, which replaces every
	 * message, including turns this adapter had named -- is named from the
	 * `thinking_level_change` entries on the session file's active branch
	 * (OW-helumu), since Pi's messages hold no level: the level in force when
	 * the turn ran, not when it was loaded. A loaded turn that cannot be matched
	 * to its entry, or ran at `off` on a model other than the current one, which
	 * may not reason, stays unlabelled (`withLoadedEfforts` in `reducer.ts`).
	 */
	private thinkingLevel: string | null = null;
	private reasoning = false;
	private chosenEffort: string | null = null;
	/**
	 * True while `set_model` awaits its answer. On `pi 0.87.1` the level it
	 * resets to is announced before that answer (MANUAL_TESTING OW-ruzuhu), so
	 * taking it at once would pair the old model with the new model's level in
	 * every update until the answer names the model (OW-zasozo). It is recorded
	 * and held until then, or until `set_model` fails, when whatever level
	 * arrived meanwhile is the old model's and is reported as it stands.
	 */
	private settingModel = false;
	private disposed = false;
	/** The one teardown, so repeat callers await it instead of running a second. */
	private disposal?: Promise<void>;
	/** Resolves when the child's `close` fires, so teardown can wait for it. */
	private closedPromise?: Promise<void>;
	private resolveClosed?: () => void;
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
		this.sessionRef = ref;
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
		this.closedPromise = new Promise<void>((resolve) => {
			this.resolveClosed = resolve;
		});

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
		const state = await this.sendCommand<PiResponseFor<"get_state">>({ type: "get_state" });
		this.adoptSessionFile(state.data.sessionFile);
		this.model = state.data.model ? modelToInfo(state.data.model).id : null;
		this.reasoning = state.data.model?.reasoning === true;
		this.thinkingLevel = state.data.thinkingLevel ?? null;
		this.syncEffort();

		// Cold start (D3): the transcript of a session that predates this
		// adapter has to be re-queried, because nothing replays the events that
		// built it. Without this, resuming renders a blank transcript until the
		// user takes another turn -- and then shows a conversation missing
		// everything before it.
		//
		// The transcript is `get_messages`, not `get_entries`: we want the active
		// branch as `AgentMessage[]`, which is the contract. `get_entries`
		// additionally carries pre-compaction history and abandoned branches
		// (rpc.md), none of which belongs in a transcript view; it is read only
		// for the level each turn ran at (`hydrateMessages`). Skipped for a fresh
		// session, which by definition has nothing to fetch.
		if (opts.resumeId) await this.hydrateMessages();
	}

	/**
	 * Adopt the real session file as our id once Pi reports one. Idempotent, and
	 * a no-op when Pi has not created the session yet.
	 */
	private adoptSessionFile(sessionFile: string | undefined): void {
		if (this.idResolved || !sessionFile) return;
		this.idResolved = true;
		if (sessionFile !== this.sessionRef.id) {
			this.sessionRef = { ...this.sessionRef, id: sessionFile };
		}
	}

	/**
	 * Replace the held transcript with Pi's own. Emits a snapshot, not an upsert.
	 * Its messages carry no level, so each assistant turn is named from the
	 * session file's entries (`withLoadedEfforts` in `reducer.ts`, OW-helumu).
	 * Both callers read `get_state` first, because whether the current model
	 * reasons decides what an `off` turn on it is named.
	 */
	private async hydrateMessages(): Promise<void> {
		const [messages, entries] = await Promise.all([
			this.sendCommand<PiResponseFor<"get_messages">>({ type: "get_messages" }),
			this.sendCommand<PiResponseFor<"get_entries">>({ type: "get_entries" }),
		]);
		const current = { model: this.model, reasoning: this.reasoning };
		const labelled = withLoadedEfforts(messages.data.messages, entries.data.entries, entries.data.leafId, current);
		this.state = { ...this.state, messages: labelled };
		this.emitUpdate(undefined);
	}

	/**
	 * Idempotent, because the server reaches one adapter from more than one
	 * direction: an explicit close and the startup's own failure path can hold
	 * the same adapter, and shutdown walks both the process table and the
	 * startups still in flight. A second `stdin.end()` raises
	 * ERR_STREAM_ALREADY_FINISHED on a stream nobody is listening to for
	 * `error`, which takes the server down; a second `kill()` re-signals a pid
	 * the OS may have already handed to something else.
	 */
	dispose(): Promise<void> {
		this.disposal ??= this.finishDisposal();
		return this.disposal;
	}

	private async finishDisposal(): Promise<void> {
		this.disposed = true;
		for (const pending of this.pendingCommands.values()) {
			pending.reject(new Error("Pi adapter disposed"));
		}
		this.pendingCommands.clear();
		const child = this.child;
		if (!child) return;
		if (!child.stdin.destroyed) child.stdin.end();
		child.kill();
		// Signalling is not reaping. The server treats this promise resolving as
		// "the agent is gone" and exits on it, so waiting for `close` is the whole
		// point -- and a sandboxed agent mid-turn does not always take the hint,
		// which is what the escalation is for. Bounded at both steps, because a
		// shutdown that hangs forever is its own failure.
		if (await this.closesWithin(TERMINATE_GRACE_MS)) return;
		child.kill("SIGKILL");
		await this.closesWithin(KILL_GRACE_MS);
	}

	private closesWithin(milliseconds: number): Promise<boolean> {
		if (this.closed) return Promise.resolve(true);
		const closed = this.closedPromise;
		if (!closed) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), milliseconds);
			// Never hold the process open on our own grace period.
			timeout.unref?.();
			void closed.then(() => {
				clearTimeout(timeout);
				resolve(true);
			});
		});
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

		// For a Pi that named no file at `start()`, this is the next point it can
		// name one. Pi 0.84.1, 0.85.1 and 0.87.1 named it at start (HANDOFF
		// finding 41, MANUAL_TESTING OW-bohodu), so this is skipped there; it
		// stays for the `virtual` case D9 describes.
		// One extra round trip, only until the id resolves.
		//
		// Awaited, because the manager reads `ref` the moment `submit()` settles
		// and a rename that lands later is one it will never hear about. But not
		// allowed to fail the submit: Pi has already accepted the prompt above,
		// and `submit()` rejecting means "the turn was not admitted" (the frozen
		// contract) -- which the HTTP layer relays as a 500 and the browser
		// answers by preserving the draft to send again. Resending would put a
		// second copy of a running prompt into the same turn. Leaving the id
		// unresolved instead costs one more probe on the next prompt, which is
		// the same path a session whose id had not resolved yet already takes.
		if (!this.idResolved) {
			try {
				const state = await this.sendCommand<PiResponseFor<"get_state">>({ type: "get_state" });
				this.adoptSessionFile(state.data.sessionFile);
			} catch {
				// Nothing to report: the turn is running. A dead process announces
				// itself through `handleClose`, and disposal is not news either.
			}
		}
	}

	async abort(): Promise<void> {
		await this.sendCommand<PiResponseFor<"abort">>({ type: "abort" });
	}

	/**
	 * Compact the session's context via Pi's `compact` command (rpc.md
	 * "Compaction", OW-72). Pi runs this as a normal command and reports the
	 * summary through the `compaction_start`/`compaction_end` notifications the
	 * reducer already sees, so this only has to issue the command and await its
	 * admission -- the transcript marker is the reducer's job.
	 */
	async compact(): Promise<void> {
		this.state = { ...this.state, compaction: "requesting" };
		this.emitUpdate();
		try {
			await this.sendCommand<PiResponseFor<"compact">>({ type: "compact" });
		} catch (error) {
			this.state = { ...this.state, compaction: null };
			this.emitUpdate();
			throw error;
		}
	}

	// -- fork-from-past -----------------------------------------------------

	/**
	 * One fork point per user message, each carrying that message's index in the
	 * flat transcript (OW-roveze).
	 *
	 * Pi forks at message granularity and `get_fork_messages` answers one entry
	 * per user message, so the two lists correspond one-to-one -- but `PaneMessage`
	 * carries no id (D11 freezes `protocol.ts`) and Pi's entry ids are not in it,
	 * so the pairing is positional either way. It is done *here* rather than in
	 * the client because this is the one place both arrays are in hand, which is
	 * what makes a disagreement detectable instead of silent.
	 *
	 * On a length mismatch this answers with no points at all. There is no honest
	 * way to say *where* the two lists diverged, and pairing the common prefix
	 * anyway would be the same silent mis-fork this change exists to remove.
	 * Losing every Edit affordance is visible and recoverable; forking one turn
	 * away from where the user pointed is neither. It is not logged either --
	 * adapters have no logger to reach for, and the whole transcript losing its
	 * Edit controls is a louder signal than a line nobody is reading.
	 */
	async listForkPoints(): Promise<ForkPoint[]> {
		const resp = await this.sendCommand<PiResponseFor<"get_fork_messages">>({ type: "get_fork_messages" });
		const entries = resp.data.messages;
		const userIndices: number[] = [];
		this.state.messages.forEach((message, index) => {
			if (message.role === "user") userIndices.push(index);
		});
		if (userIndices.length !== entries.length) return [];
		return entries.map((m, i) => ({ id: m.entryId, text: m.text, index: userIndices[i] as number }));
	}

	async fork(entryId: string): Promise<ForkResult> {
		const forked = await this.sendCommand<PiResponseFor<"fork">>({ type: "fork", entryId });
		// A `session_before_fork` extension handler can veto the fork, and Pi
		// reports that as `success: true` with `data.cancelled: true` (rpc.md,
		// "fork") -- not as an error response. Taken at face value that reads as
		// a successful fork, and we would refetch an unchanged transcript and
		// tell the caller the rewind happened. Surface the veto instead.
		if (forked.data.cancelled) {
			throw new Error(`Pi fork from entry "${entryId}" was cancelled by an extension`);
		}
		// Pi's `fork` is COPY-ON-WRITE, not the in-place rewind an earlier
		// docblock claimed (settled live on 0.84.2, MANUAL_TESTING.md OW-pifowo).
		// The original session file is left byte-identical; the process's active
		// `sessionFile` MOVES to a new file at the fork call. So the id we hold
		// has diverged from Pi's active file and must be re-adopted -- otherwise
		// a later turn is keyed to the abandoned pre-fork branch and a listing
		// indexes a stale id. The one run that measured it at this instrument
		// found that new file already on disk when the fork returned, carrying
		// the rewound prefix (0.85.1, MANUAL_TESTING.md OW-gajesu; the earlier
		// `false` is retired, but this is one sample of a race, not an
		// invariant). Nothing here depends on it -- the consequence is that a
		// discarded fork can leave a real session file for the picker to walk.
		// Unlike `adoptSessionFile` (the one-time virtual->real id adoption, gated
		// by `idResolved`), this is an already-resolved session whose active file
		// genuinely moved, so re-query `get_state` and take the reported file
		// unconditionally.
		const state = await this.sendCommand<PiResponseFor<"get_state">>({ type: "get_state" });
		this.model = state.data.model ? modelToInfo(state.data.model).id : this.model;
		if (state.data.model) this.reasoning = state.data.model.reasoning === true;
		this.thinkingLevel = state.data.thinkingLevel ?? this.thinkingLevel;
		this.syncEffort();
		if (state.data.sessionFile && state.data.sessionFile !== this.sessionRef.id) {
			this.sessionRef = { ...this.sessionRef, id: state.data.sessionFile };
		}
		// `fork` emits no message events of its own, so our held transcript is now
		// stale; re-fetch the rewound branch wholesale -- the same cold-start path
		// `start()` uses when resuming.
		this.state = { ...this.state, isStreaming: false };
		await this.hydrateMessages();
		// No `start`: the fork is the file this live process is already writing.
		return { ref: this.ref };
	}

	// -- state ----------------------------------------------------------------

	getState(): AdapterState {
		return { messages: this.state.messages, isStreaming: this.state.isStreaming, compaction: this.state.compaction, model: this.model, effort: this.state.effort };
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

	/** Takes `provider/modelId` only, and sends it unchanged; see "Model refs" in `protocol.ts`. */
	async setModel(model: string): Promise<void> {
		const { provider, modelId } = splitModelRef(model);
		this.settingModel = true;
		const response = await this.sendCommand<PiResponseFor<"set_model">>({ type: "set_model", provider, modelId })
			.catch((error: unknown) => {
				if (this.syncEffort()) this.emitUpdate();
				throw error instanceof PiCommandError ? new BackendRefusedError(modelRefusal(model, error.message)) : error;
			})
			.finally(() => {
				this.settingModel = false;
			});
		this.model = modelToInfo(response.data).id;
		this.reasoning = response.data.reasoning === true;
		this.syncEffort();
		if (this.chosenEffort !== null && thinkingLevels(response.data).includes(this.chosenEffort)) {
			await this.sendCommand<PiResponseFor<"set_thinking_level">>({ type: "set_thinking_level", level: this.chosenEffort });
		} else {
			this.chosenEffort = null;
		}
		this.syncEffort();
		this.emitUpdate();
	}

	/** Sent now, not held for the next prompt: Pi has a standalone command, and records it in the session file. */
	async setEffort(effort: string): Promise<void> {
		this.chosenEffort = effort;
		await this.sendCommand<PiResponseFor<"set_thinking_level">>({ type: "set_thinking_level", level: effort });
	}

	async listModels(): Promise<ModelInfo[]> {
		const resp = await this.sendCommand<PiResponseFor<"get_available_models">>({ type: "get_available_models" });
		return resp.data.models.map((m: Model<any>) => ({
			...modelToInfo(m),
			efforts: thinkingLevels(m).map((id) => ({ id, description: "" })),
			defaultEffort: null,
		}));
	}

	/** Bring the reducer's effort in line with the level and model last reported. Emits nothing. */
	private syncEffort(): boolean {
		const effort = this.reasoning ? this.thinkingLevel : null;
		if (effort === this.state.effort) return false;
		this.state = { ...this.state, effort };
		return true;
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
		if (parsed.type === "thinking_level_changed") {
			this.thinkingLevel = parsed.level;
			if (!this.settingModel && this.syncEffort()) this.emitUpdate();
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
			else pending.reject(new PiCommandError(resp.error));
			return;
		}
		if (!resp.success) {
			this.emitError(`Pi command "${resp.command}" failed: ${resp.error}`);
		}
	}

	private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.closed) return;
		this.closed = true;
		this.resolveClosed?.();

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
		const snapshot: AdapterState = {
			messages: this.state.messages,
			isStreaming: this.state.isStreaming,
			compaction: this.state.compaction,
			model: this.model,
			effort: this.state.effort,
		};
		for (const cb of this.updateListeners) cb(snapshot, changedIndex);
	}

	private emitRequest(request: AgentRequest): void {
		for (const cb of this.requestListeners) cb(request);
	}

	private emitError(message: string): void {
		for (const cb of this.errorListeners) cb(message);
	}
}
