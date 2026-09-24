---
labels: [change]
blocked-by: [OW-gusifo]
closed: done
---

# Pi's dialog requests are held until the session is killed

Found 2026-09-24 by the cold read of OW-gusifo, which is Codex-only in effect.

The `extension_ui_request` arm in `src/server/adapters/pi/reducer.ts` publishes the dialog methods (`select`, `confirm`, `input`, `editor`) as requests and records them in `pendingUiRequests`, and a `reply` of null answers `cancelled: true` (`extension_ui_response` in the same file).
No client can answer one: the browser has no way to (OW-bijera), and nothing in `emacs/agentpane.el` sends the helper's `requests/reply`.
So a Pi dialog hangs the turn until the session is killed, which is what D2a in `docs/DESIGN.md` decided against in its paragraph "And when the browser cannot answer either, the adapter declines rather than holding it".
That paragraph's reasoning names no backend, though the section around it is written about Codex; applying it to Pi is this card's reading, not a recorded decision.

A dialog request may carry a `timeout` (`src/server/adapters/pi/protocol.ts`), and when Pi times one out nothing tells the manager, so even after OW-gusifo the server would go on holding it and every snapshot re-send it.

Amended 2026-09-24 at execution: once a dialog is cancelled the instant it is published, no timeout can pass while the server holds it, so a test that a timed-out dialog is retracted would pass with no code behind it.
That path is live again only once OW-bijera holds dialogs, so it moved, with OW-geveja's Pi half, to OW-siguzo, blocked by OW-bijera.

No live Pi dialog request has ever been observed (OW-johano, OW-25), so this card is driven by fakes.

Load-bearing: a Pi dialog request is cancelled rather than held, the user is told what arrived by an error naming the method, and the request leaves the server's held list through OW-gusifo's retraction.
The cancel mirrors OW-zisumi's Codex decline in the `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts`: publish, then the adapter's own `reply(id, null)`, then `onRequestResolved`, then the error.

## Done when

- Tests in `src/server/adapters/pi/process.test.ts`, red first: a dialog request arriving is answered `cancelled: true`, an error names its method, and the request is retracted.
- D2a says that its decline binds Pi's dialog requests too.
- `bun run check` passes.

## Close note

Landed as "fix: cancel a Pi dialog nothing can answer instead of holding it (OW-yosuzo)".
In `handleLine` in `src/server/adapters/pi/process.ts`, a dialog `extension_ui_request` (`select`, `confirm`, `input`, `editor`) is still published, and then the adapter's own `reply(id, null)` writes `extension_ui_response` with `cancelled: true`.
After that it fires the new `onRequestResolved` under the published id, which OW-gusifo's retraction clears, and emits a session error naming the method.
That mirrors OW-zisumi's Codex decline in order and wording.
The cancel is `.catch(() => {})` rather than `void`: a dialog line still arriving on stdout after `dispose()` would otherwise leave an unhandled rejection from `writeLine`, and a test reproduces that.
OW-pivuho asks whether Codex's `void this.reply` has the same exposure.

At execution the card was amended to drop its timeout half.
Once a dialog is cancelled at arrival, no `timeout` can pass while the server holds it.
That half, together with OW-geveja's Pi half, moved to OW-siguzo, blocked by OW-bijera.

Verified: the new tests in `src/server/adapters/pi/process.test.ts` failed against the old adapter and pass now, which the dispatching session reproduced by restoring the pre-change `process.ts`.
They cover the cancel under the request id with retraction after the write, all four methods and a late reply finding nothing pending, and a fire-and-forget `notify` neither cancelled nor retracted.
`bun run check` passes on main, 1352 tests.
One piece of coverage was removed rather than moved: nothing at the adapter level still checks that a non-null reply is shaped by the stored method (`confirmed` for `confirm`).
`buildUiReplyCommand`'s reducer test still covers the shapes.
D2a now says the decline binds Pi's dialogs.
Every statement that a Pi dialog blocks has been changed: the `onRequestResolved` docblock in `types.ts`, the reducer comment, the Pi smoke probe's `--tool-check` help, and the OW-lapuye section of `docs/MANUAL_TESTING.md`.
`src/client/App.svelte`'s "end the session to clear it" warning was left alone.
No adapter now holds a published request past the line that published it, so the warning can show at most between a `request` event and its `request-resolved`.
