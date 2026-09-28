---
labels: [defect]
---

# A selected session with nothing on disk that the server let go of outside detach() and onDisconnect lands on an empty preview whose Attach can only 404

Found by the adversarial read of OW-forinu on 2026-09-28.
OW-forinu's card keeps the rule that a session the server has let go of with nothing on disk leaves the selection (OW-vasubu), and it lives today only where that is known at the moment: `detach()`'s no-disk exit and `onDisconnect`'s no-disk rows, both in `src/client/controller.ts`.
A selection that reaches the detached-loading pane any other way has its preview fetched by `loadPreview`, and `readSessionPreview` answers a gone no-disk ref with an empty but non-null transcript (see `detach()`'s docblock), so the pane shows that empty preview and its Attach can only 404.
On `main` before OW-forinu the same orderings drew a composer over no view instead, so this is not a regression; it is one bad state traded for another.

## The orderings

- Proved by probe: `create` (and likewise `forkAndSubmit`'s fork) with `api.attach` held, the stream drops, the reply lands with `onDisk: false`, the stream reconnects, and the reconnect's listing no longer names the session.
  `onDisconnect` judged only the rows it could see at the drop, and this row arrived after it through `replaceSummary`.
  The OW-wazija test in `src/client/controller.test.ts` never reconnects, so it cannot see this.
- Inferred, not probed: another client closes a selected session that has nothing on disk while this tab's stream is up; the listing evicts the view through `replaceSessionSummaries` in `src/client/session-state.ts` and drops the row, and the pane goes detached-loading and fetches the empty preview.

## What bounds the fix

A rule of "no sidebar row, so clear the selection" at the listing has a race to rule out: a listing sent before a `create` and answered after its reply, but before its snapshot, does not name the new session either, and clearing the selection there would strand the snapshot's live view unselected.
`replaceSessionSummaries` already reasons about listings older than the view (`sessionsWhenListed`, OW-fihuma); the fix likely needs the same notion of age for rows without a view.

## Done when

Tests in `src/client/controller.test.ts`, red first: each ordering above ends on the startup view (`state.selected === null`), with no empty preview on screen; and a listing answered before a `create`'s snapshot, not naming it, leaves that selection standing.
`bun run check` passes.
