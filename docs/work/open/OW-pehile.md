---
labels: [defect]
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
