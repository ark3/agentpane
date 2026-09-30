/**
 * The one process shell every backend's child runs in: the stdout and stdin
 * listeners, the stderr tail, the spawn `error`, `close`, and the kill
 * escalation. The adapters keep their protocol layers and hand this a line
 * handler; nothing here knows what a message is.
 *
 * It exists so a fix to the plumbing lands once. Pi's child had no stdin
 * `error` listener while Codex's and Claude's did, because these were three
 * copies of the same hundred lines (OW-sozopu). `docs/DESIGN.md`, "What the
 * wrapper chain does to process events", is the contract kept here.
 */

import { LfLineSplitter } from "./framing.ts";

// ---------------------------------------------------------------------------
// The child
//
// Structural subsets of the Node types, covering only what the shell touches.
// A real `ChildProcessWithoutNullStreams` satisfies them, so a real spawn needs
// no cast; a test fake needs no `node:child_process`. `any[]` in the listener
// signature is deliberate -- `unknown[]` would make concretely-typed handlers
// like `(chunk: string) => void` unassignable.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: see note above
type Listener = (...args: any[]) => void;

export interface ChildReadable {
	setEncoding(encoding: "utf8"): unknown;
	on(event: string, listener: Listener): unknown;
}

export interface ChildWritable {
	readonly destroyed: boolean;
	readonly writableEnded?: boolean;
	write(chunk: string): unknown;
	end(): unknown;
	on(event: string, listener: Listener): unknown;
}

export interface ChildLike {
	readonly stdout: ChildReadable;
	readonly stderr: ChildReadable;
	readonly stdin: ChildWritable;
	on(event: string, listener: Listener): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

/** How the shell names its backend in the errors it builds. */
export interface ChildLabels {
	/** "Failed to spawn <name> (<command>)" and "<name> process is not running". */
	name: string;
	/** "<process> exited (code=..., signal=...)". */
	process: string;
	/** "<stdin> stdin failed: ...". */
	stdin: string;
}

export type ExitHandler = (code: number | null, signal: string | null, error: Error) => void;

/**
 * How much stderr to retain for the death report. Bounded because a chatty
 * extension could otherwise grow this without limit over a long session.
 */
const STDERR_TAIL_LIMIT = 8_192;
/** One schedule, so every backend dies the same way. */
const TERMINATE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;

export class ChildProcessShell {
	private readonly splitter = new LfLineSplitter();
	private readonly spawnHandlers: (() => void)[] = [];
	private readonly lineHandlers: ((line: string) => void)[] = [];
	private readonly exitHandlers: ExitHandler[] = [];
	private stderrTail = "";
	/** Populated by the `error` event, which on a failed spawn is the only account of why. */
	private spawnError: Error | undefined;
	/** Populated by stdin's `error` event: a write into a pipe the child stopped reading. */
	private stdinError: Error | undefined;
	/** Set once the child is gone; makes teardown idempotent and writes fail loudly. */
	private closed = false;
	private killed = false;
	private spawned = false;
	/** Resolves when the child's `close` fires, so teardown can wait for it. */
	private readonly closedPromise: Promise<void>;
	private resolveClosed!: () => void;
	private killPromise: Promise<void> | null = null;

	constructor(
		private readonly child: ChildLike,
		private readonly command: string,
		private readonly labels: ChildLabels,
	) {
		this.closedPromise = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			for (const line of this.splitter.push(chunk)) this.emitLine(line);
		});
		child.stdout.on("end", () => {
			for (const line of this.splitter.flush()) this.emitLine(line);
		});

		// stderr is diagnostics, not protocol, and not per-chunk errors. Both
		// wrappers in the spawn chain write routine chatter here -- direnv
		// announces every `.envrc` it loads on stderr (verified), and sbox/bwrap
		// add their own -- so raising each chunk through an adapter's `onError`
		// would put a red banner in the UI on a perfectly healthy start.
		// `onError`'s frozen contract is "a turn failed in a way the transcript
		// does not convey", which this is not. Retain a bounded tail
		// instead and spend it on the death report, where it is the only clue to
		// why the process died.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
		});

		// A write landing after the child died but before `close` goes into a
		// pipe with no reader, and EPIPE arrives here. Unheard, it is an uncaught
		// exception that takes the server down (Node 26.8.1, OW-sozopu); heard,
		// it is the death report's reason.
		child.stdin.on("error", (error: Error) => {
			this.stdinError = error;
		});

		child.on("spawn", () => this.handleSpawn());
		child.on("error", (error: Error) => {
			this.spawnError = error;
		});
		// `close`, not `exit`: on a spawn failure (ENOENT -- `direnv` or `sbox`
		// missing from PATH) Node emits `error` and `close` but NEVER `exit`,
		// verified on this machine. Binding only `exit` meant a failed spawn left
		// Pi's readiness probe pending forever, so `start()` hung rather than
		// rejecting. `close` also fires strictly after stdio drains, so it cannot
		// reject a command whose response is still in the pipe.
		child.on("close", (code: number | null, signal: string | null) => this.handleClose(code, signal));
	}

	/** Write one message. The shell appends the LF. */
	write(line: string): void {
		// `stdin.destroyed` alone is not enough: `end()` only flips it once the
		// stream finishes, so a write issued right after `kill()` would otherwise
		// go into a pipe nobody is reading.
		if (this.killed || this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
			throw new Error(`${this.labels.name} process is not running`);
		}
		this.child.stdin.write(`${line}\n`);
	}

	/** Observe successful OS-level process creation. Never fires after a spawn failure. */
	onSpawn(cb: () => void): void {
		if (this.spawned) {
			cb();
			return;
		}
		this.spawnHandlers.push(cb);
	}

	onLine(cb: (line: string) => void): void {
		this.lineHandlers.push(cb);
	}

	/**
	 * Called once, with the reason the child is gone and the tail of its
	 * stderr. The `Error` keeps the spawn or stdin failure it names as its
	 * `cause`; the message is what adapters hand clients, as a string.
	 */
	onExit(cb: ExitHandler): void {
		this.exitHandlers.push(cb);
	}

	/**
	 * Signal termination and settle after close or bounded SIGKILL escalation.
	 * Memoised: a second call awaits the first rather than re-signalling a pid
	 * the OS may already have handed to something else.
	 *
	 * A child still not closed `KILL_GRACE_MS` after SIGKILL is reported through
	 * the exit channel: `onExit` fires, once, with code and signal null and an
	 * error naming the survivor, and a `close` arriving later is not reported
	 * again. `kill()` itself still resolves, because callers read that as their
	 * licence to exit and a shutdown that hangs forever is its own failure.
	 * As of OW-sozopu nobody hears that report: every caller of `kill()` has let
	 * go of its listeners first -- Codex's connection has no holders left,
	 * Claude's ownership is no longer live, and Pi reports no `onError` once
	 * disposed.
	 */
	kill(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.killPromise) return this.killPromise;
		this.killed = true;
		if (!this.child.stdin.destroyed) this.child.stdin.end();
		this.child.kill("SIGTERM");
		this.killPromise = this.finishTermination();
		return this.killPromise;
	}

	// Signalling is not reaping. A caller treats `kill()` resolving as "the
	// agent is gone" -- the server exits on it -- so waiting for `close` is the
	// whole point, and a sandboxed agent mid-turn does not always take the hint,
	// which is what the escalation is for. Bounded at both steps, because a
	// shutdown that hangs forever is its own failure.
	private async finishTermination(): Promise<void> {
		if (await this.closesWithin(TERMINATE_GRACE_MS)) return;
		this.child.kill("SIGKILL");
		if (await this.closesWithin(KILL_GRACE_MS)) return;
		this.settle(null, null, `${this.labels.process} did not close within ${KILL_GRACE_MS}ms of SIGKILL`);
	}

	private closesWithin(milliseconds: number): Promise<boolean> {
		if (this.closed) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), milliseconds);
			// Never hold the process open on our own grace period.
			timeout.unref?.();
			void this.closedPromise.then(() => {
				clearTimeout(timeout);
				resolve(true);
			});
		});
	}

	private emitLine(line: string): void {
		for (const handler of this.lineHandlers) handler(line);
	}

	private handleSpawn(): void {
		if (this.spawned || this.closed) return;
		this.spawned = true;
		for (const handler of this.spawnHandlers.splice(0)) handler();
	}

	private handleClose(code: number | null, signal: string | null): void {
		// On a failed spawn the exit code is meaningless (-2 for ENOENT), so the
		// `error` event's account wins when there is one.
		if (this.spawnError) {
			const reason = `Failed to spawn ${this.labels.name} (${this.command}): ${this.spawnError.message}`;
			this.settle(code, signal, reason, this.spawnError);
		} else if (this.stdinError) {
			this.settle(code, signal, `${this.labels.stdin} stdin failed: ${this.stdinError.message}`, this.stdinError);
		} else {
			this.settle(code, signal, `${this.labels.process} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
		}
	}

	/** The one death report, however the child went: `close`, or the escalation giving up. */
	private settle(code: number | null, signal: string | null, reason: string, cause?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.resolveClosed();

		const detail = this.stderrTail.trim();
		const message = detail ? `${reason}\n${detail}` : reason;
		const error = cause ? new Error(message, { cause }) : new Error(message);
		for (const handler of this.exitHandlers) handler(code, signal, error);
	}
}
