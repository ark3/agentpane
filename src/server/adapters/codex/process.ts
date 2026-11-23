/**
 * The Codex spawn seam: building the sandboxed command line and spawning it
 * into the shared process shell (`../child-process.ts`), which owns the
 * child's plumbing and LF-only framing.
 *
 * Kept apart from the reducer on purpose. Everything here touches the OS;
 * nothing here knows what a `ThreadItem` is. Tests substitute a
 * `CodexProcess` and never spawn anything.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ChildProcessShell } from "../child-process.ts";

/** The subprocess seam. One implementation spawns; the other is a test double. */
export interface CodexProcess {
	/** Write one message. The implementation appends the LF. */
	write(line: string): void;
	/** Answer a request the child sent; dropped once the child is going or gone (`ChildProcessShell.reply`). */
	reply(line: string): void;
	/** `onThrow` hears a line `cb` threw on (`ChildProcessShell.onLine`). */
	onLine(cb: (line: string) => void, onThrow?: (message: string) => void): void;
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
 * sbox recognises the `codex` profile by command name: it mounts `~/.codex`
 * read-write, which Codex's sqlite state runtime needs, and injects
 * `--sandbox danger-full-access`, which `app-server` ignores. As of
 * `codex-cli 0.154.0` (2026-09-12, `docs/MANUAL_TESTING.md`, OW-pibivi) a
 * `thread/start` with no `sandbox` key reported `readOnly` with the flag and
 * without it. So neither policy belongs on this command line: the adapter
 * sends `sandbox` and `approvalPolicy` on every `thread/start`,
 * `thread/resume` and `thread/fork` (D7a; `CodexAdapter.fork` for why a fork
 * needs them too).
 */
export function codexCommand(cwd: string): { command: string; args: string[] } {
	return { command: "direnv", args: ["exec", cwd, "sbox", "--", "codex", "app-server"] };
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
	return new ChildProcessShell(child, command, {
		name: "Codex",
		process: "codex app-server",
		stdin: "Codex app-server",
	});
};
