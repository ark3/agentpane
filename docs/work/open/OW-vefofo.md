---
labels: [deferral]
---

# The SIGKILL survivor report cannot tell a child that outlived SIGKILL from one that exited while something else still holds its pipes

Found 2026-09-30 by the adversarial read of OW-tozuyo, on `main` at ea4e835.
In service of the report that `ChildProcessShell.finishTermination` in `src/server/adapters/child-process.ts` writes to stderr and fires through `onExit` (`"<process> did not close within 1000ms of SIGKILL"`), and of the `docs/DESIGN.md` bullet "A child that outlives SIGKILL is given up on, not waited for", under "What the wrapper chain does to process events".

The shell waits for the child's `close` event, which needs the process to exit **and** its stdio to close; it never listens for `exit`.
The reader measured, with a plain `node:child_process` spawn, `sh -c "sleep 5 & exec sleep 100"`: `exit` arrived at 203ms and `close` only at 4980ms, and `child.kill("SIGKILL")` returned `false` because the pid had already exited, so no SIGKILL was ever sent.
`child.pid` is the outer `bwrap` (`direnv exec` keeps the pid, and sbox ends in `os.execvp("bwrap", ...)`), and `bwrap --unshare-all --die-with-parent` with a background grandchild closed 505ms after SIGTERM.
So in practice this branch fires when something other than the named pid still holds the pipes — a D-state process inside the sandbox, say — while the process the report talks about is gone.
That is why OW-tozuyo dropped the pid from the stderr line, and it means "outlives SIGKILL", in the message, the `kill()` docblock and the DESIGN bullet, describes a case the shell cannot observe.

Deferred because the report still means that something the server spawned has not let go, which is what a person needs to know at shutdown.
The decision this card holds is whether the shell should listen for `exit` too, and word the report by which of `exit` and `close` it did and did not see.

## Done when

The decision is made either way and recorded in that DESIGN bullet.
If the shell is changed, a test in `src/server/adapters/child-process.test.ts` drives a fake child that emits `exit` but not `close` past `KILL_GRACE_MS` and asserts the report says the process exited with stdio still held, red before the change.
