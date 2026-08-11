/**
 * The process shell: building the sandboxed command line, and reading LF-framed
 * lines off a child's stdout.
 *
 * Kept apart from the reducer on purpose. Everything here touches the OS;
 * nothing here knows what a `ThreadItem` is. Tests substitute a
 * `CodexProcess` and never spawn anything.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_TAIL_LIMIT = 8_192;
const TERMINATE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;

/** The subprocess seam. One implementation spawns; the other is a test double. */
export interface CodexProcess {
	/** Write one message. The implementation appends the LF. */
	write(line: string): void;
	onLine(cb: (line: string) => void): void;
	onExit(cb: (code: number | null, signal: string | null, error?: Error) => void): void;
	/** Signal termination and settle after close or bounded SIGKILL escalation. */
	kill(): Promise<void>;
}

export interface CodexSpawnOptions {
	/**
	 * The session's workspace. This is both the child's cwd and the path
	 * `direnv exec` / `sbox` are pointed at -- get it wrong and sbox jails the
	 * wrong tree while direnv loads the wrong environment (D7).
	 */
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * `direnv exec <workspace> sbox -- codex app-server` (D7). The server builds
 * this itself: no `sandboxed-codex` wrapper exists on PATH, and one seam is
 * easier to test than a PATH dependency.
 *
 * sbox recognises the `codex` profile by command name -- it mounts `~/.codex`
 * read-write (Codex needs a writable sqlite state runtime) and injects
 * `--sandbox danger-full-access` so Codex does not double-sandbox inside
 * bubblewrap. Neither flag belongs here; adding one by hand would fight sbox.
 */
export function codexCommand(cwd: string): { command: string; args: string[] } {
	return { command: "direnv", args: ["exec", cwd, "sbox", "--", "codex", "app-server"] };
}

/**
 * Split a byte stream into lines on **LF only**.
 *
 * Deliberately not `readline`: it also splits on U+2028/U+2029, which are
 * legal inside JSON strings and would corrupt a message carrying either
 * (HANDOFF, "Pi RPC framing is LF-only" -- the same hazard applies to any
 * JSON-lines transport, Codex included).
 */
export class LineSplitter {
	private buffer = "";

	push(chunk: string, emit: (line: string) => void): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = stripTrailingCr(this.buffer.slice(0, newline));
			this.buffer = this.buffer.slice(newline + 1);
			emit(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	/** Whatever is left after the stream closed, if it is a complete-looking line. */
	flush(emit: (line: string) => void): void {
		if (this.buffer.length === 0) return;
		const rest = stripTrailingCr(this.buffer);
		this.buffer = "";
		emit(rest);
	}
}

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export type CodexSpawner = (options: CodexSpawnOptions) => CodexProcess;

/** The real spawner. Injectable so nothing in the test suite starts a process. */
export const spawnCodex: CodexSpawner = ({ cwd, env }) => {
	const { command, args } = codexCommand(cwd);
	const child: ChildProcessWithoutNullStreams = spawn(command, args, {
		cwd,
		env: env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return new ChildCodexProcess(child, command);
};

class ChildCodexProcess implements CodexProcess {
	private splitter = new LineSplitter();
	private lineHandlers: ((line: string) => void)[] = [];
	private exitHandlers: ((code: number | null, signal: string | null, error?: Error) => void)[] = [];
	private stderrTail = "";
	private spawnError: string | undefined;
	private stdinError: string | undefined;
	private closed = false;
	private killed = false;
	private readonly closedPromise: Promise<void>;
	private resolveClosed!: () => void;
	private killPromise: Promise<void> | null = null;

	constructor(
		private child: ChildProcessWithoutNullStreams,
		private command: string,
	) {
		this.closedPromise = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.splitter.push(chunk, (line) => this.emitLine(line));
		});
		child.stdout.on("end", () => this.splitter.flush((line) => this.emitLine(line)));

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
		});
		child.stdin.on("error", (error: Error) => {
			this.stdinError = `Codex app-server stdin failed: ${error.message}`;
		});

		child.on("error", (error: Error) => {
			this.spawnError = `Failed to spawn Codex (${this.command}): ${error.message}`;
		});
		child.on("close", (code, signal) => this.handleClose(code, signal));
	}

	private emitLine(line: string): void {
		for (const handler of this.lineHandlers) handler(line);
	}

	write(line: string): void {
		if (this.killed || this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
			throw new Error("Codex process is not running");
		}
		this.child.stdin.write(`${line}\n`);
	}

	onLine(cb: (line: string) => void): void {
		this.lineHandlers.push(cb);
	}

	onExit(cb: (code: number | null, signal: string | null, error?: Error) => void): void {
		this.exitHandlers.push(cb);
	}

	kill(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.killPromise) return this.killPromise;
		this.killed = true;
		this.child.stdin.end();
		this.child.kill("SIGTERM");
		this.killPromise = this.finishTermination();
		return this.killPromise;
	}

	private async finishTermination(): Promise<void> {
		if (await this.closesWithin(TERMINATE_GRACE_MS)) return;
		this.child.kill("SIGKILL");
		await this.closesWithin(KILL_GRACE_MS);
	}

	private closesWithin(milliseconds: number): Promise<boolean> {
		if (this.closed) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), milliseconds);
			timeout.unref?.();
			void this.closedPromise.then(() => {
				clearTimeout(timeout);
				resolve(true);
			});
		});
	}

	private handleClose(code: number | null, signal: string | null): void {
		if (this.closed) return;
		this.closed = true;
		this.resolveClosed();

		const reason =
			this.spawnError ??
			this.stdinError ??
			`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
		const detail = this.stderrTail.trim();
		const error = new Error(detail ? `${reason}\n${detail}` : reason);
		for (const handler of this.exitHandlers) handler(code, signal, error);
	}
}
