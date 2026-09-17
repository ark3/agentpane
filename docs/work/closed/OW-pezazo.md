---
labels: [defect]
closed: done
---

# A late SSE event can re-light the streaming dot on a session that was just detached

Found while reviewing OW-tewave, which added the Detach item that drops a session's live view from `view.state.sessions`.

`src/client/session-state.ts`: `reduceServerEvent` accepts any event for a key it does not know -- `acceptsSequence(undefined)` is true -- and recreates the entry through `emptySession`.
Events already on the wire when the server's `broadcaster.forget` ran can therefore land after the client has dropped the view, resurrecting it.

The transcript is safe: `previewing` in `src/client/App.svelte` gates on `view.preview`, so the pane stays read-only.
What is visible is the session list's per-row streaming dot, which reads `view.state.sessions[key]?.isStreaming ?? summary.isStreaming` -- a late `status` event re-lights it on a dead session until the next re-list cleans it through `replaceSessionSummaries`.

That is exactly the untruthful indicator OW-tewave exists to remove, which is the reason to file it; it is also self-healing on the next listing, which is the reason it was not fixed there.

Done when a client-state test feeds a `status` event for a key that is not in `sessions` and asserts it is ignored rather than resurrected -- red first -- and the session list no longer shows the dot in that window.

## Close note

Fixed on `main` as a251657 (implemented on a worktree branch as ae39507, amended in review).

`reduceServerEvent` in `src/client/session-state.ts` now returns the state unchanged -- identity preserved, so no re-render -- when the key has no view, before the `acceptsSequence` check.
So `upsert`, `status`, `error` and `request` may only update a view; `snapshot` and `renamed` still create, which is what the senders do: `sendOpeningSnapshots` on connect, `broadcastSnapshot` on both branches of `attach`, and `Broadcaster.renamed` following its own event with a snapshot for the new ref.
The ignore requests no recovery either, deliberately: a recovery there would `api.attach` and re-spawn the session behind the user, which is OW-sugome from the other side.

The dot needed no separate coverage in `App.test.ts`.
With the entry never created, the row's `view.state.sessions[key]?.isStreaming ?? summary.isStreaming` falls through to the summary, and a detached session lists `isStreaming: false`; both halves of that expression are already covered there ("shows a streaming indicator only for a session that is streaming", "takes the row's dot from the live session map rather than the listed summary").

Red first: the existing test "accepts the first sequenced event for a session without a snapshot" asserted the defect verbatim and was replaced by its inverse, "ignores a status event for a session it holds no view of, rather than resurrecting one (OW-pezazo)", which failed against the old reducer with the resurrected view -- `{ isStreaming: true, seq: 4, messages: [] }` where `undefined` was expected.
Green after: `bun run check` clean, 1107 tests in 50 files, ~23s.
No browser check; this is state logic jsdom settles.

Review dispatched an adversarial reader at the finished work and it found the change sound but its docblock false where it claimed "no sender reaches these arms first".
It does not hold: `#start` in `src/server/http/session-manager.ts` subscribes `onUpdate`, `onRequest` and `onError` before awaiting `adapter.start(...)`, and `broadcaster.setSnapshotSource` answers `null` until `bound.adapter = adapter` after that await, so an in-window `broadcastSnapshot` is a no-op; `#adoptRef(session, "fork")` is a second such window (D20, OW-suhoto).
Confirmed both in the source before accepting.
A dropped `upsert` or `status` there costs nothing -- the following snapshot carries those fields wholesale -- but `error` and `requests` are in no snapshot and in no attach response, so they are lost for good.
That residue is filed as OW-bipume, with the two server-side repairs it names; the amended docblock records the reasoning and points there.
Keeping all four non-creating was the judgment: exempting `error` buys back a Pi stray-stdout diagnostic and pays with the more visible half of the resurrection defect, an alert banner over a session the user just detached.
