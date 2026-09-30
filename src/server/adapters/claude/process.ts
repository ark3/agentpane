/**
 * The Claude Code spawn seam: building the sandboxed command line and spawning
 * it into the shared process shell (`../child-process.ts`), which owns the
 * child's plumbing and LF-only framing (`../framing.ts`). Nothing here knows
 * what a `ClaudeEvent` is; tests substitute a `ClaudeProcess` and never spawn.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ChildProcessShell } from "../child-process.ts";

/** The subprocess seam. One implementation spawns; the other is a test double. */
export interface ClaudeProcess {
	/** Write one message. The implementation appends the LF. */
	write(line: string): void;
	/** Observe successful OS-level process creation. Never fires after a spawn failure. */
	onSpawn(cb: () => void): void;
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
	/** Start at this effort (`--effort`); how the adapter restores a stored one on a resume or fork. */
	effort?: string;
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
 * sbox. `--verbose` is passed unconditionally because CLI 2.1.267 refuses the
 * full stream-json shape without it (OW-jihete). Versions 2.1.238 and 2.1.247
 * did not require it (OW-yilabe, OW-bumota), so do not infer a stable version
 * boundary; every observed version accepts the flag.
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
	if (opts.effort) args.push("--effort", opts.effort);
	if (opts.resumeId) args.push("--resume", opts.resumeId);
	if (opts.forkAtEntryId) args.push("--resume-session-at", opts.forkAtEntryId, "--fork-session");
	if (opts.sessionId) args.push("--session-id", opts.sessionId);
	return { command: "direnv", args, cwd: opts.cwd };
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
	return new ChildProcessShell(child, command, { name: "Claude Code", process: "claude", stdin: "claude" });
};
