---
labels: [change]
blocked-by: [OW-gusifo]
---

# Pi's dialog requests are held until the session is killed, and one Pi times out is never retracted

Found 2026-09-24 by the cold read of OW-gusifo, which is Codex-only in effect.

The `extension_ui_request` arm in `src/server/adapters/pi/reducer.ts` publishes the dialog methods (`select`, `confirm`, `input`, `editor`) as requests and records them in `pendingUiRequests`, and a `reply` of null answers `cancelled: true` (`extension_ui_response` in the same file).
No client can answer one: the browser has no way to (OW-bijera), and nothing in `emacs/agentpane.el` sends the helper's `requests/reply`.
So a Pi dialog hangs the turn until the session is killed, which is what D2a in `docs/DESIGN.md` decided against in its paragraph "And when the browser cannot answer either, the adapter declines rather than holding it".
That paragraph's reasoning names no backend, though the section around it is written about Codex; applying it to Pi is this card's reading, not a recorded decision.

A dialog request may carry a `timeout` (`src/server/adapters/pi/protocol.ts`), and when Pi times one out nothing tells the manager, so even after OW-gusifo the server would go on holding it and every snapshot re-send it.
OW-geveja covers the adapter's own half of that timeout: the stale `pendingUiRequests` entry and the error a late reply raises.

No live Pi dialog request has ever been observed (OW-johano, OW-25), so this card is driven by fakes.

Load-bearing: a Pi dialog request is cancelled rather than held, the user is told what arrived by an error naming the method, and the request leaves the server's held list through OW-gusifo's retraction, whether it was cancelled or timed out.
Incidental: whether the cancel goes out at arrival or through `reply`, and whether this card absorbs OW-geveja's Pi half.

## Done when

- Tests in `src/server/adapters/pi/process.test.ts`, red first: a dialog request arriving is answered `cancelled: true`, an error names its method, and the request is retracted; a dialog whose `timeout` passes is retracted.
- D2a says that its decline binds Pi's dialog requests too.
- `bun run check` passes.
