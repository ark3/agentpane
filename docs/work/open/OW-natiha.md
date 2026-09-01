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
`src/server/adapters/types.ts` opens by calling the adapter contract a `FROZEN INTERFACE` and asking that a change be raised before it is made, and extending `AdapterState` is exactly that change; the owner settled its shape on 2026-09-01, as follows.
`AdapterState` gains one field, `compaction: "requesting" | "running" | null` — a bare enum, not an object, because nothing consumes a payload and there is no cancel.
Terminal is the return to `null`: success and failure already travel on the `compactionSummary` marker and the existing error event, so no terminal value is stored.
The field is required, not optional, so every construction site in the three adapters gets a type error and must say something rather than defaulting to idle by omission.
On the wire, `compaction` rides the two `ServerEvent` arms that already carry `isStreaming` — `snapshot` and `status` — and nowhere else; it does not join `SessionSummary`, because the gating concerns the selected session, not the session list.
Each adapter's `compact()` sets `requesting` and fires `onUpdate` before sending the backend command, and clears it before rethrowing if the send fails, so the adapter stays the single owner of the state and the session manager stays a pure broadcaster.
The reducers own `requesting → running` and the clear, and they clear `compaction` in the same update that appends the `compactionSummary` marker, which makes the terminal transition agree with the marker structurally rather than by timing.
Keep the state per session because another attached session can update while the user is looking elsewhere.
Do not represent compaction as ordinary `isStreaming`: compaction is not a user-stoppable generation turn, even where Codex or Claude exposes it through generic active-turn signals.
The generic signals do make the composer offer Stop today, on two of the three backends; see the next section for where they come from.

## Where Stop comes from today

Codex models manual compaction as an ordinary turn.
`resources/fixtures/codex/compact.jsonl` wraps the `contextCompaction` item in a `turn/started`/`turn/completed` pair and drives `thread/status/changed` to `active` around it, which `src/server/adapters/codex/reducer.ts` turns straight into `isStreaming` through its `setStreaming(message.params.status.type === "active")` arm.
Claude reaches the same place: `resources/fixtures/claude/compact.jsonl` carries `system` with `subtype: "status"` and `status: "compacting"`, and the `system/status` arm of `src/server/adapters/claude/reducer.ts` sets streaming for any non-null status.
Pi does not, because the arm of `src/server/adapters/pi/reducer.ts` commented `queue_update/compaction_start/auto_retry_start/summarization_* are` gives `compaction_start` no effect on `isStreaming`.
So `App.svelte` shows both the `Stop` button and the `Stop and edit` label during a compaction on Codex and Claude and neither on Pi.
Those reducers are reporting their backends' wire truth rather than misreading it, so the asymmetry is only removable once compaction is separately known, which is what this card builds.
The owner settled how (2026-09-01): the reducers keep reporting wire truth on both fields, and the client gives `compaction` precedence in the action row — while it is non-null the composer shows the compacting status and no Stop, whatever `isStreaming` says.
The asymmetry therefore survives on the wire and dies at the rendering; do not suppress the generic active-turn signals in the reducers, where an unseen event ordering could eat a real turn.
OW-81 recorded the Codex half of this from a live run without the fixture behind it.

## Compaction the user did not invoke

Compaction that a backend starts on its own gets the same treatment as a click.
Pi's `compaction_start` carries `reason: "manual" | "threshold" | "overflow"`; ignore it.
The gating exists to keep a concurrent turn out of a backend that cannot admit one, and that does not depend on who asked.
Blocking Send without showing why would be a dead composer, which is worse than the defect this card fixes, so the status appears for those too.
Only requesting is user-initiated, so an auto-compaction enters at running and never shows the requesting text.

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
A reducer test drives Pi's `compaction_start` with `reason: "threshold"` and asserts the same running transition a manual one produces, with no requesting state ahead of it.
The behavior-changing tests are watched red against the current request-scoped implementation before the fix.
Because this changes the composer action row, `bun run test:browser` covers its visible placement without horizontal overflow and is run locally alongside `bun run check`.
