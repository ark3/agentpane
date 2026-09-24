---
labels: [deferral]
---

# A session error or pending request reaches no client that was not already holding a view

Found while reviewing OW-pezazo, which stopped `reduceServerEvent`'s sequenced arms from creating a session view, and named this as the residue it does not close.

`src/shared/protocol.ts`: a `snapshot` event carries `messages`, `isStreaming`, `compaction` and `model`, and `AttachSessionResponse` carries `{ session: SessionSummary }`.
Neither carries `error` or `requests`.
Those two fields of `SessionView` (`src/client/session-state.ts`) therefore reach a client only as the `error` and `request` events themselves, at the instant they are fanned out, and nothing ever restores them.

Three consequences, all pre-dating OW-pezazo except the third:

- A client that connects after a request was raised never learns of it: `sendOpeningSnapshots` in `src/server/http/broadcaster.ts` sends snapshots and nothing else.
- The same client never learns of a turn error already recorded.
- Since OW-pezazo, an `error` or `request` fanned out before the session has been introduced to any client is dropped by every client rather than creating a view that holds it.
  That window is real: `#start` in `src/server/http/session-manager.ts` subscribes `onUpdate`, `onRequest` and `onError` before it awaits `adapter.start(...)`, and `broadcaster.setSnapshotSource` answers `null` until `bound.adapter = adapter` runs after that await, so a `broadcastSnapshot` inside the window is a no-op.
  `#adoptRef(session, "fork")` is a second such window: it re-keys a live Pi container onto the fork's ref emitting only `sessionsChanged` (D20, OW-suhoto), so events fan out under a key no client holds until the client's own `api.attach(forked)` lands.

What it would cost a user: the `App.svelte` banner "The agent is blocked on a request agentpane cannot answer" never appearing on a session that is in fact blocked -- which also leaves Tools -> Detach enabled, since `detachable` requires `requests.length === 0`.
Measured reachability as of this filing: Claude Code's `onRequest` is inert without `--permission-prompt-tool`, Pi raises requests only from turn notifications and a freshly spawned Pi has no turn running, and D18/OW-zogogo records that under `approvalPolicy: "never"` no approval request has been observed reaching agentpane at all as of `codex-cli 0.154.0`.
The in-window `error` is likelier: Pi's stdout handler is live from the spawn, so a non-JSON line during startup calls `emitError` before any snapshot exists (`src/server/adapters/pi/process.ts`).

Since OW-tujiya a third field has the same gap: `notices`, a backend's non-fatal warnings, carried by a per-session `notice` event and by no snapshot the server sends.
`#start` subscribes `onNotice` beside `onError`, so a notice fanned out while `adapter.start(...)` is awaited reaches no client either.
That window may be where Codex's `configWarning` normally arrives, if app-server sends its config warnings right after answering `initialize`; that timing is a reviewer's recollection of the codex-rs source, not a measurement, and a bare `codex app-server` under a `CODEX_HOME` whose config holds an unknown key, sent only `initialize`, would settle it.
A fork's borrower joins its parent's connection after `initialize`, so it would never hear such a notice even with the window closed.
The Emacs helper holds the notices it has seen and replays them on each `session/snapshot`, but that only survives a redraw, not a reconnect or a late attach.

Deferred rather than fixed because the repair is on the server and the card that surfaced it is a client one.
Load-bearing: that the snapshot is the only restoring path a client has, and it carries neither field.
Incidental: which repair.
The shapes, none costed -- add `error` and `requests` to `SnapshotSource` and the `snapshot` event, so every introduction carries them; or publish `bound.adapter` before `await adapter.start(...)` so an in-window `broadcastSnapshot` stops no-opping, which closes the startup window only and leaves the reconnect gap standing.

Done when a client that connects to a server holding a session with a pending request shows the blocked banner for it without a gesture, pinned by a test that goes red first, and one that connects after a notice was raised shows that notice, pinned the same way.
If the decision instead is that these fields are deliberately ephemeral, that closes this card too, recorded beside `SnapshotSource` in `src/server/http/broadcaster.ts` and in the OW-pezazo docblock in `src/client/session-state.ts` that currently points here.
