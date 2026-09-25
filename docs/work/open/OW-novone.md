---
labels: [defect, emacs]
---

# When another buffer attached a session's new ref before the helper's live lookup answered, the helper drops the stale buffer's attachment silently and that buffer stays frozen

Found 2026-09-25 by the adversarial read of OW-gusaru; reasoned, not reproduced.
In service of the same D21 reconnect gap as OW-gusaru, and of one session never showing in two buffers (OW-danifa).

Buffer A holds handle H1. In one outage of the helper's stream, the session is re-attached elsewhere under H2 and renamed to R2, and buffer B then attaches R2.
The outcome depends on order:

- If A's move wins, the lookup answers before B's reply. `reconcile` in `src/emacs/helper.ts` moves A onto H2 with a `movedFrom` snapshot, and B's attach reply absorbs B into A (`agentpane--attached-as` and `agentpane--absorb` in `emacs/agentpane.el`).
- If B's reply wins, B already holds H2, so `reconcile` takes its `drop(held)` branch for H1. That branch tells Emacs nothing, and A counts itself attached with a frozen transcript.

The OW-gusaru implementer's analysis gives a direction.
Sending the `movedFrom` snapshot from the `drop(held)` branch is truthful on the helper's side, but alone it merges nothing.
`agentpane--notified-buffer` routes by the notification's own handle first, so B redraws and `movedFrom` is never read.
The mode would also need to absorb the buffer `movedFrom` names into the holder of the snapshot's handle when those are two buffers, which gives the same survivor as the other order.
The tradeoff to weigh is that `agentpane--absorb` today follows the user's own attach. Here a background notification would kill A and move its windows, draft and composer, and any request A has in flight dies with it.

Done when a test in `src/emacs/helper.test.ts` and an ert test in `emacs/agentpane-test.el` each go red first and green after.
In the helper test, B's attach reply lands before A's lookup answers, and A's handle then no longer stands frozen: either Emacs receives a notification the ert test routes to A, or A is absorbed into B.
`bun run check` green, and the ert run passes as the header of `emacs/agentpane.el` describes.
