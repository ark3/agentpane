/**
 * The process shell for Claude Code: building the sandboxed command line, and
 * reading LF-framed lines off the child's stdout. Nothing here knows what a
 * `ClaudeEvent` is; tests substitute a `ClaudeProcess` and never spawn.
 *
 * Framing is strict NDJSON with LF as the only delimiter, per
 * `pi/framing.ts`'s rationale: `readline` also splits on U+2028/U+2029, which
 * are legal inside JSON strings.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_TAIL_LIMIT = 8_192;
const TERMINATE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;

/** The subprocess seam. One implementation spawns; the other is a test double. */
export interface ClaudeProcess {
	/** Write one message. The implementation appends the LF. */
	write(line: string): void;
	onLine(cb: (line: string) => void): void;
	onExit(cb: (code: number | null, signal: string | null, error?: Error) => void): void;
	/** Signal termination and settle after close or bounded SIGKILL escalation. */
	kill(): Promise<void>;
}

export interface ClaudeSpawnOptions {
	/**
	 * The session's workspace: the `direnv exec` target AND the child's OS-level
	 * cwd (D7) -- direnv loads the env but does not chdir, and sbox resolves its
	 * jail from the process cwd (see `pi/spawn.ts`'s module doc).
	 */
	cwd: string;
	model?: string;
	/** Resume this stored session (`--resume`). */
	resumeId?: string;
	/**
	 * Choose the session id at spawn (`--session-id`) -- settled live 2026-08-25
	 * (MANUAL_TESTING OW-yilabe `session-id.jsonl`, and OW-beripo for the
	 * combination with `--fork-session`): the CLI adopts the caller's uuid for
	 * `init.session_id` and the store filename, including for a fork. This is
	 * what lets the adapter know a fork's id without waiting for a turn.
	 */
	sessionId?: string;
	/**
	 * Fork the resumed session, truncated INCLUSIVE of this store-line uuid
	 * (`--resume-session-at <uuid> --fork-session`, MANUAL_TESTING OW-mayuza).
	 * Requires `resumeId`.
	 */
	forkAtEntryId?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * `direnv exec <cwd> sbox -- claude -p --input-format stream-json
 * --output-format stream-json --verbose --include-partial-messages` (D7).
 *
 * sbox recognises the `claude` profile by command name: it mounts `~/.claude`
 * and injects `--permission-mode bypassPermissions` (verified 2026-08-25 via
 * `sbox --dry-run`). Neither is passed here; adding either by hand would fight
 * sbox. `--verbose` is passed unconditionally because it is harmless, not
 * because it is needed: 2.1.238 and 2.1.247 both stream without it, against
 * the base shape and the full resume/fork/session-id shape alike (OW-yilabe,
 * OW-bumota). It is kept for the build reported to require it — 2.1.246,
 * never probed (OW-misoru) — which passing it costs nothing to cover.
 */
export function buildClaudeSpawnCommand(opts: ClaudeSpawnOptions): {
	command: string;
	args: string[];
	cwd: string;
} {
	const args = [
		"exec",
		opts.cwd,
		"sbox",
		"--",
		"claude",
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.resumeId) args.push("--resume", opts.resumeId);
	if (opts.forkAtEntryId) args.push("--resume-session-at", opts.forkAtEntryId, "--fork-session");
	if (opts.sessionId) args.push("--session-id", opts.sessionId);
	return { command: "direnv", args, cwd: opts.cwd };
}

/** Split a byte stream into lines on **LF only** (see module doc). */
class LineSplitter {
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

export type ClaudeSpawner = (options: ClaudeSpawnOptions) => ClaudeProcess;

/** The real spawner. Injectable so nothing in the test suite starts a process. */
export const spawnClaude: ClaudeSpawner = (options) => {
	const { command, args, cwd } = buildClaudeSpawnCommand(options);
	const child: ChildProcessWithoutNullStreams = spawn(command, args, {
		cwd,
		env: options.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return new ChildClaudeProcess(child, command);
};

class ChildClaudeProcess implements ClaudeProcess {
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
			this.stdinError = `claude stdin failed: ${error.message}`;
		});

		child.on("error", (error: Error) => {
			this.spawnError = `Failed to spawn Claude Code (${this.command}): ${error.message}`;
		});
		child.on("close", (code, signal) => this.handleClose(code, signal));
	}

	private emitLine(line: string): void {
		for (const handler of this.lineHandlers) handler(line);
	}

	write(line: string): void {
		if (this.killed || this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
			throw new Error("Claude Code process is not running");
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
			`claude exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
		const detail = this.stderrTail.trim();
		const error = new Error(detail ? `${reason}\n${detail}` : reason);
		for (const handler of this.exitHandlers) handler(code, signal, error);
	}
}
