---
labels: [unverified]
---

# Neither `CodexConnectionRegistry.forget` call site is individually tested, because the fake app-server exits synchronously inside `kill()`

Found by the adversarial read of OW-voyezi's fix, 2026-09-15, reading the tests against the production code.

OW-voyezi added a registry of live `codex app-server` connections by thread id, so a re-attach on a thread a live child still holds borrows that child rather than spawning one that would be refused `-32600 already has an active writer`.
An entry is dropped in two places in `src/server/adapters/codex/connection.ts`: `CodexConnection.release`, on the last holder leaving, and the `onExit` handler the constructor installs on the `CodexClient`.

In production those two cover different windows.
`release` covers the gap between `proc.kill()` being asked for and the child actually exiting -- an attach landing in that gap must not borrow a connection on its way out.
`onExit` covers a child that dies while holders are still attached, which `release` never runs for at all.

Neither window has a test.
The reason is the fake: `LockingProcess.kill()` in `src/server/http/session-manager.test.ts`, in the describe block "re-attaching a thread a live app-server still holds (OW-voyezi)", calls its release hook and then fires every `onExit` handler **synchronously inside `kill()`** -- which a real child never does.
So in that fake the two `forget` calls are redundant: delete either one and the test "spawns again once the last holder has killed the child" still passes, because the other fires in the same tick.
That test's `expect(cluster.procs).toHaveLength(2)` therefore reads stronger than it is.

## Done

Each `forget` call site is shown to be load-bearing on its own: with the other one deleted, a test goes red.
Concretely, two cases the current fake cannot express --

- a child whose exit is asynchronous (the fake defers its `onExit` rather than firing it inside `kill()`), attached to during the gap between `kill()` and that exit, which must spawn rather than borrow;
- a child that exits while holders are still attached, after which an attach on a thread it held must spawn.

Whether that is best served by deferring the fake's exit, by a second fake, or by a unit test at `CodexConnection`/`CodexConnectionRegistry` rather than through `SessionManager` is the implementer's call.
The measured CLI behaviour the fake stands in for is in `docs/MANUAL_TESTING.md`, "`thread/unsubscribe` does not release a Codex thread's writer lock (OW-voyezi)" and the section after it, both on `codex-cli 0.154.0`.

This is a test-strength card, not a defect report: both `forget` call sites were read as individually correct, and no sequence was found in which the registry hands out a dead connection.
