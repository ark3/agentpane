---
labels: [defect, now]
closed: done
---

# Any `sessions-changed` broadcast wipes the view-level error and stomps `busy`, which is why every `finally` in the controller has to re-check it

`src/client/controller.ts`, `refreshSessions()`: it publishes `busy: "listing", error: null` on entry and `error: null` again on success.
`src/client/session-state.ts` returns a re-list request on every `sessions-changed`, which any client's attach, close, or first-prompt rename triggers.
The most common trigger is this session's own rename on first prompt, so a submit failure that races that broadcast is visible for milliseconds at most.
The `busy` write is the same problem from the other side: it overwrites `"attaching"` or `"submitting"` mid-flight, which is why each `finally` in the file tests `view.busy === ...` before restoring.
No test covers either.

A list refresh has no business touching the view error, and listing should be a separate flag from the one the composer reads, or not surfaced at all when it was not user-initiated.

## Done when

A test in `controller.test.ts` publishes an error, delivers `sessions-changed`, and asserts the error survives; a sibling asserts `busy` stays `"submitting"` across a re-list during a held prompt.
Both fail before the change.

## Close note

Landed as 0494cf4 on `main`.

`refreshSessions` in `src/client/controller.ts` took a `surface: boolean`.
The exported `refreshSessions()` (the Refresh button, `e2e/perf-harness.ts`, and `start()`) passes `true` and is unchanged: `busy: "listing"`, an entry error clear, a surfaced failure, `"idle"` restored in `finally`.
The `onEvent` handler's `result.refreshSessions` path passes `false` and publishes only the new summaries.
The exported signature did not change — it is wired as `() => refreshSessions(true)` — so `App.svelte` and the fakes needed nothing.
The redundant `error: null` on the success path is gone in both branches: a listing has no business clearing an error it did not raise.

**The card understated the trigger.**
It says the most common source is this session's own rename at its first prompt.
In fact `src/server/http/session-manager.ts` broadcasts `sessionsChanged()` at *every* turn boundary, start and end, to keep the `updatedAt` sort moving (OW-furinu).
So a re-list landed inside the `"submitting"` of every prompt, not just the first — the defect was routine rather than a corner.
Verified by reading that call site; the code comment and the test comment both say so now.

That is why this card mattered beyond the error wipe: it is what makes OW-nasofa's `if (busyIs("submitting")) return;` guard actually hold.
Before this, the prompt's own broadcast cleared `busy` to `"idle"` mid-flight and a second Ctrl-Enter a few hundred milliseconds later still double-sent.

Four tests in `src/client/controller.test.ts`, all watched red before and green after by the dispatching session as well as the implementer (restore `controller.ts` from the base commit, keep the tests, run `bun run test src/client/controller.test.ts`):

- "keeps the view error through a broadcast-driven re-list" — `expected null to be 'Select a session before submitting a …'`
- "leaves busy at submitting across a broadcast-driven re-list" — `expected 'idle' to be 'submitting'`
- "ignores a second submit after the in-flight prompt's own re-list" — `expected "spy" to be called once, but got 2 times`.
  This is the OW-nasofa reproduction, and it is the one that proves the two cards together close the hole.
- "surfaces a failure to a Refresh that joined a broadcast-driven re-list" — `expected null to be 'list is down'`

The fourth came out of review, not the card.
`refreshInFlight` coalescing reads before `surface` does, so a Refresh press landing during a broadcast re-list joins it and inherits its silence — and since turns broadcast, that window is common.
Pre-change, such a press at least saw the listing's failure; the first cut lost that.
Fixed with a `refreshSurfacing` flag a joining gesture can raise, four lines: the press does not get a spinner it never got before, but it owns the error slot again.

Review also confirmed no `view.busy === ...` re-check in the file is dead — `select()` during a held `submit()`, and `recover()` off a sequence gap, still overlap independently of the re-list — so all of them stayed.
`replaceSessionSummaries` never touches `state.selected`, and `refreshPreview` already declines to seize the error slot, so the silent path is genuinely silent.

Also filed: OW-yasewo, for `recover()`, which has this same defect through the sequence-gap door and reopens the OW-nasofa guard.
