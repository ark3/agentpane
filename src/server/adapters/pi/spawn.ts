/**
 * Builds the argv for spawning Pi through the sandbox (D7), without doing
 * any spawning itself -- kept pure and separate so the exact command line
 * is unit-testable without a subprocess.
 *
 * `direnv exec <cwd> sbox -- pi --mode rpc [--session <resumeId>] [--model <model>]`
 *
 * One easy-to-miss thing, verified empirically on this machine rather than
 * assumed from the `direnv exec DIR COMMAND` man page phrasing: `direnv exec
 * DIR COMMAND` loads DIR's `.envrc` into COMMAND's environment, but does
 * **not** change COMMAND's working directory --
 *
 *   $ cd /scratch && direnv exec /scratch/subdir pwd
 *   /scratch          <- NOT /scratch/subdir
 *
 * sbox auto-detects its workspace from `Path.cwd()` (`sbox:resolve_workspace`
 * calls `Path.cwd()` directly, not an argv). So `opts.cwd` has to be passed
 * to the spawned process as a real OS-level `cwd` in addition to appearing
 * in argv for direnv -- argv alone silently jails the wrong tree. DESIGN.md
 * already says this ("the server must spawn each subprocess with cwd = that
 * session's workspace"); this is the mechanism that makes it true, worth
 * having in one place since it is easy to satisfy only the argv half and
 * still be broken.
 */

export interface PiSpawnOptions {
	/** The session's workspace; becomes both the `direnv exec` target and the process's OS cwd. */
	cwd: string;
	/** Resume an existing session; Pi's id is its JSONL path (D9), which is exactly what `--session` accepts. */
	resumeId?: string;
	/** `provider/modelId`, matching Pi's own `--model` CLI pattern (see `protocol.ts`'s `modelToInfo`/`splitModelRef`). */
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
