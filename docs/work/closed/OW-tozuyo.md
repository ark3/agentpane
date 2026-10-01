---
labels: [deferral]
closed: done
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

## Close note

Built (ea4e835): `ChildProcessShell.finishTermination` in `src/server/adapters/child-process.ts` now writes the survivor to stderr with `console.error`, then fires the existing synthetic `onExit`. The write happens before `kill()` resolves, so it reaches a person on every kill path that awaits `kill()`, shutdown included (`app.close()` → `disposeAll()` → adapter `dispose()` → `kill()` → `process.exit(0)` in `src/server/index.ts`). No adapter or the session manager is in a position to swallow it.
The `kill()` docblock and the DESIGN bullet "A child that outlives SIGKILL is given up on, not waited for" now say where the report goes.

Verified: assertions in `child-process.test.ts` (the shell's own survivor test) and in `pi/process.test.ts` "escalates to SIGKILL when the child ignores SIGTERM" check for exactly one stderr line. The Pi test drives `PiAdapter.dispose()`, the call shutdown makes, after the adapter has stopped reporting `onError`. Both went red with the fix reverted ("expected error to be called once, but got 0 times") and green with it. `bun run check` passes, 1591 tests.
Not tested: the `disposeAll()` chain itself. Review traced it for all three backends: sessions, startups, in-flight closes, parked forks, and Codex connections with several holders all await `kill()`, with no timeout above it.

Review removed a pid the implementer added to the line. `child.pid` is the outer bwrap, which can be gone while something else holds the pipes; see OW-vefofo.
Review also found one path where the report is still lost: a Codex adapter disposed during its own failed start resolves before its kill finishes. Filed as OW-sujizi.
A second Ctrl-C (`process.exit(130)`) drops the report by design.
