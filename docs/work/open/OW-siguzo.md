---
labels: [deferral]
blocked-by: [OW-bijera]
---

# A Pi dialog that times out while held is never retracted, and its pendingUiRequests entry never expires

Filed 2026-09-24 while executing OW-yosuzo, which moved the timeout half here.

OW-yosuzo makes the Pi adapter cancel every dialog request (`select`, `confirm`, `input`, `editor`) the instant it publishes it, as OW-zisumi does for Codex: publish, `reply(id, null)`, retract through `onRequestResolved`, error naming the method.
So while that holds, no dialog is pending long enough for Pi's `timeout` to pass, and every path below is unreachable.
OW-bijera, once a human can answer, is expected to hold dialogs again (D2a in `docs/DESIGN.md`, the paragraph "This is provisional"), and then all of it is live with nothing handling it.

- Retraction on timeout.
  A dialog request may carry a `timeout` in milliseconds (`PiExtensionUiRequestEvent` in `src/server/adapters/pi/protocol.ts`; `editor` carries none), and when Pi times one out it tells nobody, so the server would go on holding the request and every snapshot re-send it.
  The adapter has to fire `onRequestResolved` (`BackendAdapter` in `src/server/adapters/types.ts`, added by OW-gusifo) when that time passes.
  Whether Pi sends anything on timeout has never been observed: no live Pi dialog request has been (OW-johano, OW-25), so the timeout is read from the protocol type alone.
- `pendingUiRequests` in `src/server/adapters/pi/reducer.ts` keeps a timed-out entry, and a late `reply()` in `src/server/adapters/pi/process.ts` then writes an `extension_ui_response` Pi rejects, which `handleResponse` raises as a red-banner error.
  Expire the entry on its own timeout and answer a late reply quietly.
- `fork()` does not clear `pendingUiRequests`, though a rewind abandons whatever was pending; clear it there, and retract what it held.

This half of the work was OW-geveja's Pi half, moved here because it shares the blocker; OW-geveja keeps its Claude half.
If OW-bijera keeps cancelling Pi dialogs at arrival, this card is moot.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, with a held dialog carrying a `timeout`, advances fake timers past it and asserts `onRequestResolved` fired with the request's id and a late `reply()` produces no error; red first.
- A test in the same file asserts `fork()` retracts a held dialog and empties `pendingUiRequests`; red first.
- `bun run check` passes.
