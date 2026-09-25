---
labels: [deferral, emacs]
closed: done
---

# A render that throws while the Emacs helper flushes its held nodes crashes the helper from the timer, or fails a request that succeeded, and loses the nodes held behind it

Found by the adversarial read of OW-jeruye on 2026-09-25; judged unlikely and not worth blocking that card.

OW-jeruye moved rendering out of `onEvent` and into `flushNodes` in `src/emacs/helper.ts`, which runs from two places: the `NODE_INTERVAL_MS` timer and the `write` wrapper every notification and JSON-RPC reply goes through.
`flushNodes` clears `waiting` before its loop, and calls `projectTarget` in `src/emacs/nodes.ts`, which calls the injected `render`.
Before OW-jeruye, a throw from `render` inside `onEvent` rejected the stream reader's `run()` in `src/emacs/sse.ts`, which the helper treats as a disconnect and reopens after `reconnectDelayMs`.
Now:
- From the timer, the throw is uncaught in a `setTimeout` callback, which most likely ends the Bun helper process and with it agentpane-mode's connection.
- From `respond`'s `write`, a request whose REST call succeeded -- `sessions/prompt`, say -- is answered with a JSON-RPC error, because the throw lands in `respond`'s catch.
- Either way, the held nodes after the one that threw are lost, since `waiting` was already cleared.

The renderer is `src/emacs/render.ts`: marked plus DOMPurify, with a try/catch of its own, which is why this is filed as a deferral and not a defect; nobody has seen a render throw.
In service of the helper surviving a bad node the way it did before OW-jeruye: one node failing to render should cost that node, not the process or an unrelated reply.

Done: a test in `src/emacs/helper.test.ts`, with a `render` that throws for one text and vitest's fake timers, goes red first and green after, showing that a throw at flush -- from the timer and from a reply's write -- neither escapes the timer nor turns a successful reply into an error, and that the other held nodes still go out.

## Close note

Landed in a738326: `flushNodes` in `src/emacs/helper.ts` now skips a held node whose `projectTarget` throws and sends the rest, so a render throw at flush costs that node and nothing else, whether the flush runs from the `NODE_INTERVAL_MS` timer or from a reply's or notification's write.
The "Nodes are throttled (OW-jeruye)" docblock says so and why; a throw from a `setTimeout` callback was measured ending a Bun 1.4.0 process with exit 1.
Verified by two tests in `src/emacs/helper.test.ts` under "the node throttle (OW-jeruye)", with a `render` that throws for the text `unrenderable`: on the unfixed code the timer case threw `render failed` out of `flushNodes` and the reply case answered a successful `sessions/prompt` with `-32603` and lost the good node held behind the bad one; both pass after, as does `bun run check`.
The adversarial read found this is a guard at one of three consumers of the same failure — snapshots and previews render through the same `text` closure in `src/emacs/nodes.ts` and still propagate a throw, and the skip is silent — so OW-zugetu carries moving containment into `nodes.ts` and retiring this guard.
