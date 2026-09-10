---
labels: [defect, now]
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
