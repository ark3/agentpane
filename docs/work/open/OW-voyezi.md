---
labels: [defect]
---

# Re-attaching a Codex session whose thread another session still holds open fails with "already has an active writer"

Found by the adversarial read of OW-lajehi's fix, 2026-09-15, reading the code rather than running it; deliberately left out of that card's scope so the fix could land.

OW-lajehi made a Codex fork's adapter borrow the parent's `codex app-server` instead of spawning its own, because as of `codex-cli 0.154.0` only the process that minted a forked thread may open it.
The child now outlives every holder but the last (`src/server/adapters/codex/connection.ts`, `CodexConnection.release`).
That is what the card wanted, and it opens a case that used to be closed by the kill.

## The sequence

Attach a Codex session, fork it, attach the fork -- one app-server now holds writer locks on both threads.
`DELETE` the parent: `CodexAdapter.dispose` releases its holder, the fork is still holding, so the child survives and nothing ever tells it to let go of the parent's thread.
`GET` the parent again: it is gone from `#sessions` and from `#aliases`, there is no `#pendingForks` entry for it, so `SessionManager.#start` falls through to `this.#index.get(ref)`, finds the rollout on disk, and takes the `factory.create(session.ref)` path -- a second app-server, `thread/resume`, and `-32600 already has an active writer` surfacing as `500 internal_error`.

The symmetric case is the same defect and probably likelier: close the fork after attaching it, then re-attach the fork.
Its entry left `#pendingForks` when the attach consumed it, and the rollout is on disk, so it takes the same factory path against a child that still holds its thread.

Before OW-lajehi, closing the parent killed its app-server and released every lock it held, which is exactly how that card's own probe recovered -- `docs/MANUAL_TESTING.md`, "Forking the most recent turn and attaching the fork, on all three backends", the sentence beginning "The holder is the parent session's own app-server process".
So this is a regression of behaviour that worked, narrow to the window where one side of a fork pair is closed while the other still lives.

## The two shapes of fix, and what is unmeasured between them

`thread/unsubscribe` exists in `resources/codex-protocol/ClientRequest.ts` and agentpane never sends it.
**Whether it releases the writer lock is unmeasured** -- the OW-lajehi runs only ever released a lock by killing the process -- and settling that decides which fix is even available.
Measure it before designing: a probe beside `resources/probes/codex_fork_same_process_probe.py`, which already stands up one app-server and two threads, is most of the vehicle.

If it does release the lock, the releasing adapter can send it and the factory path is correct again.
If it does not, the manager has to stop taking the factory path for a thread some live `CodexConnection` still holds: it would need to find a connection by thread id and re-borrow, which is the seam OW-lajehi explicitly did not build -- see the `#pendingForks` docblock in `src/server/http/session-manager.ts` and the `CodexConnection` class docblock.

Whatever the answer, record it in `docs/MANUAL_TESTING.md` with the `codex-cli` version it was measured on, and correct the `CodexConnection` docblock's account of how a holder lets go if it turns out to be incomplete.

## Done

A test in `src/server/http/session-manager.test.ts` that attaches a Codex session, forks it, attaches the fork, closes the parent and re-attaches the parent -- red before the change, green after -- plus the same shape with the fork and parent swapped.
The live confirmation is `resources/probes/fork_attach_probe.py --backend codex` extended to close one side and re-attach it, naming the `codex-cli` version the run records.
