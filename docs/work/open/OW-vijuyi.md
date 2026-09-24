---
labels: [defect]
---

# A Codex reattach to a thread with a running turn can lose live notifications that land before its hydrate

Found while reviewing OW-kelene on 2026-09-24; read from the code, never run.

In `src/server/adapters/codex/adapter.ts`, both `start()` (the `opts.resumeId` branch) and `startBorrowed()` answer `thread/resume`, then await other work, then call `this.reducer.hydrate(...)`, which begins with `reset()`.
The reducer's identity is already set by `setIdentity` before that await, so a notification for the thread that arrives in the gap is applied to the reducer and then wiped by the hydrate.
The gap is not new: before OW-kelene it was the `readStoredTurn` disk read.
OW-kelene widened it by the `thread/turns/list` round trips in `readTurns`, which run after that read.

The only path that can hit this is the borrowed re-attach of a thread a live app-server still holds (OW-voyezi; see the `session-manager.test.ts` block "re-attaching a thread a live app-server still holds (OW-voyezi)").
Hitting it needs that thread's turn to still be running at the re-attach.
A fresh app-server resuming from disk has no running turn, and a fork's borrower starts before anything can submit on it.
What would break: deltas and item events landing in the gap disappear from the transcript until the turn's items complete, and the reducer's streaming state resets, so the UI may show the session idle while its turn runs.
Whether `thread/turns/list` returns an in-progress turn's partial items at all, as of `codex-cli 0.156.0`, has not been measured, and that decides how much is lost.

Done when an adapter test in `src/server/adapters/codex/adapter.test.ts` shows a notification emitted between the resume's answer and the last `thread/turns/list` page surviving into `getState()`, red against today's adapter first.
Or, if a live measurement shows the window cannot lose anything, close this with that measurement recorded in `docs/MANUAL_TESTING.md` with the CLI version.
