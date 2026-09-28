---
labels: [defect, emacs]
closed: moot
---

# The Emacs helper re-attaches on any sequence gap with no guard against a sessions/close in flight, the gap OW-sugome closed in the browser

Found by the adversarial read of OW-dakeyi on 2026-09-28, read and not run.
In service of a close in flight reaching nothing on the session it is closing, from either client.

`onEvent` in `src/emacs/helper.ts` runs `api.attach(ref)` for every entry of `reduceServerEvent`'s `recover`, unconditionally.
The browser's same recovery (`recover` in `src/client/controller.ts`) returns early for a session its `detaching` set holds, which OW-sugome added so that a sequence gap landing while a Detach is out cannot respawn the session behind the user; the helper has no counterpart.
Its `sessions/close` handler awaits `api.close` and only then runs `forget`, so throughout the disposal a gap for that ref attaches it again, and the server, waiting out the disposal (`SessionManager.attach`'s `#disposing` wait in `src/server/http/session-manager.ts`), spawns it afresh with no buffer holding it.
The window is narrow: the server stops broadcasting under the handle as its close starts, so only events already in flight can open a gap.

What is load-bearing: the helper owns the close in flight for the ref, from the request to its answer, and its recovery reads that; OW-sugome's close note records how the browser placed the same state.

Done when a test in `src/emacs/helper.test.ts`, red first, sends `sessions/close` for an attached ref, holds its REST reply, drives a sequence gap for that ref, and asserts no `attach` reaches the API; `bun run check` green.

## Close note

Moot under D25 (2026-09-28): the helper no longer answers a sequence gap by attaching (OW-filuge detaches the session instead), and no route but attach spawns (OW-sirofi), so there is no respawn for a close in flight to guard against.
