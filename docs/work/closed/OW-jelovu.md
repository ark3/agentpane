---
labels: [change]
---

# Carry a per-session compaction operation state through AdapterState, the three reducers, the session manager, and the wire.

This is the server half of OW-natiha, split out on 2026-09-01 so each half fits one dispatch; OW-natiha keeps the user-facing defect and the composer work and is blocked on this card.
`src/server/adapters/types.ts` (`AdapterState`), `src/server/adapters/pi/reducer.ts`, `src/server/adapters/claude/reducer.ts`, `src/server/adapters/codex/reducer.ts`, `src/server/http/session-manager.ts` (`#onUpdate`), and `src/shared/protocol.ts` (the `snapshot` and `status` arms of `ServerEvent`) are the starting points.
OW-72 established the eventual `compactionSummary` transcript marker, and OW-81 added request-scoped feedback that dies at request admission; this card makes the server know a compaction is in flight so a client can read it from a snapshot instead of reconstructing it from local timing.

## The settled shape

Both files this card extends call their contracts a `FROZEN INTERFACE` and ask that a change be raised before it is made; the owner settled this change on 2026-09-01, so an implementer extends them without reopening the question.
`AdapterState` gains one field, `compaction: "requesting" | "running" | null` — a bare enum, not an object, because nothing consumes a payload and there is no cancel.
Terminal is the return to `null`: success and failure already travel on the `compactionSummary` marker and the existing error event, so no terminal value is stored.
The field is required, not optional, so every construction site in the three adapters gets a type error and must say something rather than defaulting to idle by omission.
On the wire, `compaction` rides the two `ServerEvent` arms that already carry `isStreaming` — `snapshot` and `status` — and nowhere else; it does not join `SessionSummary`, because the gating concerns the selected session, not the session list.
Each adapter's `compact()` sets `requesting` and fires `onUpdate` before sending the backend command, and clears it before rethrowing if the send fails, so the adapter stays the single owner of the state and the session manager stays a pure broadcaster.
The reducers own `requesting → running` and the clear, and they clear `compaction` in the same update that appends the `compactionSummary` marker, which makes the terminal transition agree with the marker structurally rather than by timing.
A backend error terminates the state and continues through the existing visible error path.
Keep the state per session because another attached session can compact while the user is looking elsewhere.

## Backend boundaries

Use the committed compact fixtures to ground the transitions: Pi has `compaction_start` and `compaction_end`, Claude has `system/status` with `status: "compacting"` and `compact_boundary`, and Codex has its compact turn plus `contextCompaction` item lifecycle.
Codex models manual compaction as an ordinary turn: `resources/fixtures/codex/compact.jsonl` wraps the `contextCompaction` item in a `turn/started`/`turn/completed` pair and drives `thread/status/changed` to `active` around it, which the codex reducer turns into `isStreaming` through its `setStreaming(message.params.status.type === "active")` arm.
Claude reaches the same place through the `system/status` arm of its reducer, which sets streaming for any non-null status; Pi does not, because the arm of its reducer commented `queue_update/compaction_start/auto_retry_start/summarization_* are` gives `compaction_start` no effect on `isStreaming`.
Those reducers are reporting their backends' wire truth, and they keep doing so: do not suppress the generic active-turn signals while compaction runs, where an unseen event ordering could eat a real turn.
The client resolves the overlap instead by giving `compaction` precedence over `isStreaming`, which is OW-natiha's half.

## Compaction the backend started on its own

An auto-compaction gets the same state as a click, entering at `running` with no `requesting` ahead of it, because only `requesting` is user-initiated.
Pi's `compaction_start` carries `reason: "manual" | "threshold" | "overflow"`; ignore it — the state exists to keep a concurrent turn out of a backend that cannot admit one, and that does not depend on who asked.

## Done when

Reducer or adapter tests replay each committed compact fixture and assert one start and one terminal compaction transition around the existing marker, with a failure case clearing the state into the error path.
An HTTP or protocol test demonstrates that an admitted compact POST does not mean completion and that a snapshot can recover an in-progress compaction state.
A reducer test drives Pi's `compaction_start` with `reason: "threshold"` and asserts the same running transition a manual one produces, with no requesting state ahead of it.
Any test whose assertion the current code could already satisfy is watched red against it first.
`bun run check` passes; no browser run is needed here, because the composer changes stay in OW-natiha.

Implemented required per-session compaction state for Pi, Claude, and Codex from request admission through backend running and terminal clear, and carried it through snapshots and status events without adding it to SessionSummary.
Successful completion now broadcasts the compaction marker and idle state atomically, command-send failures clear before rejection, backend errors retain their visible error path, backend-initiated compactions enter running, and interrupted Codex compact turns cannot remain stuck.
Fixture, adapter, HTTP reconnect, and terminal-edge tests were observed red before their fixes and pass afterward.
`bun run check` passed on main with 47 test files and 880 tests; no browser run was needed because this card did not change the composer or browser layout.
Landed in 2ee32d9 and e6e4ba7.
