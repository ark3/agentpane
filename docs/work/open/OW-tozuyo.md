---
labels: [deferral]
---

# A child that outlives SIGKILL is reported by the process shell and heard by nobody

Left by OW-sozopu, which made the one process shell report the survivor and could not make anyone hear it.

As of b3e0cad, `ChildProcessShell.finishTermination` in `src/server/adapters/child-process.ts` fires `onExit` once with null code and signal and a "did not close within ...ms of SIGKILL" error when the child has not closed `KILL_GRACE_MS` after SIGKILL, and `kill()` still resolves.
Its `kill()` docblock names why nobody hears it: every caller has let go of its listeners first.
Codex's `CodexConnection` kills only once no holder remains; Claude's `finishDisposal` in `claude/adapter.ts` marks ownership not live before `kill()`, so its `onExit` handler returns early; `PiAdapter.handleClose` in `pi/process.ts` suppresses `emitError` once disposed.
A rejected `dispose()` would reach nobody either: `src/server/http/session-manager.ts` swallows it with `.catch(() => {})` in `close()`'s disposal and settles `disposeAll()` with `Promise.allSettled` without reading the results, and `src/server/index.ts` logs only if `app.close()` itself throws.

This is the condition `docs/DESIGN.md` worries about under "Remaining open questions" ("Whether killing the spawned process actually stops the agent") and "What the wrapper chain does to process events" ("A child that outlives SIGKILL is given up on, not waited for"): a sandboxed agent left holding its workspace after the server believes it gone.
What is load-bearing is that the survivor reaches something a person reads — the server's stderr is enough — and that it does so at shutdown, where the server exits right after.
Where the report is emitted (the shell itself, or the manager reading the settled results) is the picker's call; the shell's `kill()` docblock and DESIGN's bullet must say where it now goes.

Done when a test drives a child that ignores SIGKILL (fake timers, as `src/server/adapters/child-process.test.ts` already does) through the path the server takes at shutdown and asserts the survivor is written to the log channel chosen, red before the change; and the `kill()` docblock no longer says nobody hears it.
