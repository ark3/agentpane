/**
 * Builds the argv for spawning Pi through the sandbox (D7), without spawning
 * anything, so the command line is unit-testable:
 *
 * `direnv exec <cwd> sbox -- pi --mode rpc [--session <resumeId>] [--model <model>]`
 *
 * `opts.cwd` must also be the spawned process's OS-level cwd, not only
 * direnv's argument: `direnv exec DIR COMMAND` loads DIR's `.envrc` but does
 * not chdir (verified empirically, recorded 2026-08-11: `cd /scratch &&
 * direnv exec /scratch/subdir pwd` printed `/scratch`), and sbox resolves
 * its workspace from `Path.cwd()` (`sbox:resolve_workspace`), so argv alone
 * silently jails the wrong tree. This is the one statement of the mechanism behind DESIGN's
 * "the server must spawn each subprocess with cwd = that session's workspace".
 */

export interface PiSpawnOptions {
	/** The session's workspace; becomes both the `direnv exec` target and the process's OS cwd. */
	cwd: string;
	/** Resume an existing session; Pi's id is its JSONL path (D9), which is exactly what `--session` accepts. */
	resumeId?: string;
	/**
	 * Passed to Pi's `--model` unchanged, which takes more than `set_model` does, a thinking-level suffix included; "Model refs" in `protocol.ts` states both.
	 * A resume passes none: Pi restores the model and level its session file
	 * recorded (the note at `#start`'s spawn in `session-manager.ts`).
	 */
	model?: string;
}

export interface PiSpawnCommand {
	command: string;
	args: string[];
	/** Pass this as the child process's `cwd` option -- see the module doc. */
	cwd: string;
}

export function buildPiSpawnCommand(opts: PiSpawnOptions): PiSpawnCommand {
	const args = ["exec", opts.cwd, "sbox", "--", "pi", "--mode", "rpc"];
	if (opts.resumeId) args.push("--session", opts.resumeId);
	if (opts.model) args.push("--model", opts.model);
	return { command: "direnv", args, cwd: opts.cwd };
}
