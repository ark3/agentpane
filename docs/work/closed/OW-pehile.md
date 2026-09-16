---
labels: [defect]
closed: done
---

# Detach's enablement predicate should refuse a session mid-compaction, as the Compact item's already does

`src/client/App.svelte` (`detachable`, and the Compact menuitem's `disabled` three lines from it), `src/client/App.test.ts`.

Found while reviewing OW-tewave.

The Compact item guards on `compaction !== null`.
The Detach item OW-tewave added does not: its predicate is D12's reaper exemption -- attached or virtual, not streaming, no pending request -- plus `!view.sending`.
`close()` kills the subprocess, so a compaction running when the click lands is killed with it, and that is the same loss the `isStreaming` conjunct exists to prevent (OW-japuzo).

Whether any backend can actually reach that state is unmeasured.
`streamingAction`'s docblock, a few lines below `detachable`, says Codex and Claude expose a compaction through their generic active-turn signals, which would mean `isStreaming` already covers them; it implies Pi does not, and that has never been run.
The fix does not wait on that.
The conjunct is one line, it reads a field the session already carries, it licenses no new code, and it makes two items in the same menu agree -- so the measurement decides only whether the guard is live or inert, never whether to write it.
The owner settled that framing on 2026-09-16 after the predicate was first filed as a question gated on the measurement.

What is load-bearing: the inconsistency with the Compact item sitting three lines away.
The Pi behaviour is incidental to this card, and a version-stamped measurement in `docs/MANUAL_TESTING.md` is still worth having whenever someone is on that backend anyway.

Done when `detachable` carries `compaction === null` and `src/client/App.test.ts` refuses Detach for a selection whose session reports a compaction, in the `refusedWhen` case list OW-tewave left there -- shown red against the predicate as it stands first.

## Close note

`detachable` in `src/client/App.svelte` gained a fourth conjunct, `compaction === null`, so the Detach menuitem now refuses a session mid-compaction exactly as the Compact menuitem three lines below it always has.
`close()` kills the subprocess, so a compaction running when the click landed died with it -- the same loss the `isStreaming` conjunct exists to prevent (OW-japuzo).
The docblock above `detachable` was extended in the same voice, naming the reason and recording that the reachability is unmeasured.

Verified: a new case in the `refusedWhen` list in `src/client/App.test.ts` (the list OW-tewave left there) renders a selection whose live session reports `compaction: "running"` and asserts the Detach item is disabled.
It was shown red first against the predicate as it stood -- `expect(element).toBeDisabled()` failed, the item rendered enabled -- and green after the conjunct.
`bun run check` passes on main: 50 files, 1100 tests.
Landed as 702d84e.

Still unmeasured and deliberately not gated on: whether any backend reaches a compaction that `isStreaming` does not already cover. `streamingAction`'s docblock says Codex and Claude expose one through their generic active-turn signals and implies Pi does not; a version-stamped run in `docs/MANUAL_TESTING.md` is worth having whenever someone is on Pi anyway. That decides only whether this guard is live or inert.
