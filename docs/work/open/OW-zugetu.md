---
labels: [deferral, emacs]
---

# A render that throws in the Emacs helper is contained per node at the flush but nowhere else, and leaves no trace

Found by the adversarial read of OW-vejeka on 2026-09-25.

OW-vejeka made `flushNodes` in `src/emacs/helper.ts` skip a held node whose `projectTarget` throws, so a render throw there costs that node and not the process, an unrelated reply, or the other held nodes.
That is a guard at one of three consumers of the same failure.
`render` is called from one place, the `text` closure in `nodeFor` in `src/emacs/nodes.ts`, and reaches Emacs three ways: the throttled flush, snapshots through `notifySnapshot` (which calls `projectTranscript`) in `src/emacs/helper.ts`, and previews through the `sessions/preview` handler there.
The render is deterministic in its text, so a node the flush skipped throws again on that session's next snapshot:
- From `onEvent`, the throw rejects the SSE reader's `run()` in `src/emacs/sse.ts`, the helper reopens after `reconnectDelayMs`, the server snapshots every live session on connect, and the same transcript throws again — a disconnect loop that stalls every attached session in that Emacs.
- From `reconcile`, it is an unhandled rejection of `void reconcile()`, which ends the process (measured on Bun 1.4.0, exit 1, 2026-09-25).
- From the `sessions/attach` handler, a successful attach is answered with an error.
This predates OW-jeruye, which is why OW-vejeka scoped snapshots out.

The skip is also silent: the `catch` in `flushNodes` writes nothing, though the helper's stderr already reaches the `*agentpane stderr*` buffer (`emacs/agentpane.el`), so the first render throw anyone meets leaves no evidence.
A skipped new node leaves a gap in Emacs that nothing heals, since the snapshot that would redraw it throws on the same text.

In service of render failure having one owner: contain it where `render` is called, in `nodes.ts`, so a failed render costs one text part in every consumer and the node still goes out with its index, and retire the per-node `try`/`catch` OW-vejeka put in `flushNodes`.
What a failed part carries instead of HTML is this card's decision to make and record in the `nodes.ts` docblock; leaving the failure traceable, say one stderr line naming what failed, is part of it.
The renderer, `src/emacs/render.ts`, has its own try/catch and nobody has seen it throw, which is why this is a deferral.

Done: tests in `src/emacs/helper.test.ts`, with a `render` that throws for one text, go red first and green after, showing that a snapshot carrying that text goes out with the other parts intact from `onEvent`, from `reconcile` and before an attach's reply, and the flush's own per-node catch is gone with the OW-vejeka tests still green.

## Amended 2026-09-28 under D25

Under D25 the helper exits when its stream drops (OW-mepufi), so a render throw that ends the stream no longer makes a reconnect loop that stalls every attached session: it ends the helper and detaches every buffer (OW-kakate).
The defect stands; only its consequence above changes.
