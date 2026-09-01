---
labels: [defect, browser-testing]
---

# Compaction feedback ends at request admission, leaving a live backend operation invisible until its transcript marker arrives.

`src/client/controller.ts` (`ControllerView.busy` and `compact`), `src/client/App.svelte` (`status`, `streamingNow`, and `.prompt-actions`), `src/shared/protocol.ts` (`ServerEvent` snapshots and status), `src/server/adapters/types.ts` (`AdapterState`), `src/server/http/session-manager.ts` (`#onUpdate`), and the three backend reducers are the starting points.
OW-72 established the eventual `compactionSummary` transcript marker, and OW-81 added request-scoped `busy === "compacting"` feedback.
The owner now observes that the OW-81 status is gone after request admission and before the marker arrives, so the successful click still feels like a no-op during the backend work.

## The lifecycle to represent

Model compaction as a per-session operation with at least requesting, running, and terminal states rather than as the lifetime of `api.compact()`.
Publish requesting immediately when the user invokes Compact so acknowledgment does not wait for a backend event.
Move to running when the attached backend reports that compaction began, and remain non-idle until that same operation reports success or failure.
Use the committed compact fixtures to ground the backend boundaries: Pi has `compaction_start` and `compaction_end`, Claude has `system/status` with `status: "compacting"` and `compact_boundary`, and Codex has its compact turn plus `contextCompaction` item lifecycle.
A successful terminal transition must agree with the appearance of the `compactionSummary` marker rather than with the POST response.
A backend error must terminate the state and continue through the existing visible error path.
Carry the operation state through `AdapterState`, the session manager and the multiplexed server protocol so a reconnecting client receives the truth in a snapshot instead of reconstructing it from local timing.
Keep the state per session because another attached session can update while the user is looking elsewhere.
Do not represent compaction as ordinary `isStreaming`: compaction is not a user-stoppable generation turn, even where Codex or Claude exposes it through generic active-turn signals.
If those generic signals currently make the composer offer Stop during compaction, distinguish or mask them so the new feedback does not imply that Stop is the intended control.

## What the user sees

Keep a persistent status beside the control that initiated the operation in `.prompt-actions`, such as `Compaction requested…` followed by `Compacting context…`, until the marker or error arrives.
Expose the changing text as an accessible live status.
The exact wording and whether it uses a spinner are incidental, but it must remain visible after the Tools popover closes and must not require looking at the masthead.
Disable another Compact and prevent Send, Fork, and their keyboard paths from starting work in that session while compaction is requesting or running, since the backends cannot safely admit a concurrent turn.
Do not add a cancel or Stop affordance for compaction.
Keep Tools usable if doing so is useful for New conversation; only the conflicting actions are load-bearing.

## Done when

A controller test resolves `api.compact()` before any backend lifecycle update and asserts that the selected session still reads as compacting until a terminal server event arrives.
Reducer or adapter tests replay each committed compact fixture and assert one start and one terminal compaction transition around the existing marker, with a failure case clearing the state into the error path.
An HTTP or protocol test demonstrates that an admitted POST does not mean completion and that a snapshot can recover an in-progress compaction state.
An `App.test.ts` test asserts that the composer acknowledgment survives request resolution, Compact and Send or Fork cannot fire during it, no compaction Stop control appears, and the acknowledgment clears when the marker-backed terminal update arrives.
The behavior-changing tests are watched red against the current request-scoped implementation before the fix.
Because this changes the composer action row, `bun run test:browser` covers its visible placement without horizontal overflow and is run locally alongside `bun run check`.
