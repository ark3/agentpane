---
labels: [defect]
closed: done
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

## Close note

Fixed in `CodexReducer.hydrate` (`src/server/adapters/codex/reducer.ts`): it no longer starts with `reset()`, and lays the paged-in turns under the slots the live stream already built.
An item the stream opened or completed keeps its live slot, in the listed copy's position, so its text shows once whether or not `thread/turns/list` already held it; an item the listing lacks follows the history; streaming and compaction state are kept.
Nothing is replayed, so no delta is applied twice.
`reset()` had no other caller and was removed; only the two start paths call Codex `hydrate`, so no later re-hydrate can inherit stale slots.
The `adoptConnection` docblock now says `hydrate` keeps what the thread said in the meantime; the adapter's seeding order is unchanged.

Verified by two tests in `src/server/adapters/codex/adapter.test.ts`, block "re-attaching a thread whose turn is running (OW-vijuyi)": a fork is closed and re-attached over the parent's app-server, and `turn/started`, `item/started` and a delta are emitted on the first of two `thread/turns/list` pages.
One listing omits the running turn, the other already holds its text.
Both went red against the old reducer (the assistant message missing; `isStreaming` false) and green after; `bun run check` green.

Not reached: deltas for an item that started before the attach still drop until its slot exists; filed as OW-zudase, along with the unmeasured question of whether `thread/turns/list` returns in-progress items.
