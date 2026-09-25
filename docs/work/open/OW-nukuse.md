---
labels: [defect, emacs]
---

# A detach Emacs sends for a handle the helper has just moved leaves the attachment on the new handle, feeding no buffer

Noticed 2026-09-25 by both the implementer and the adversarial reader of OW-gusaru. The reader reasoned it through; it was not reproduced.
It predates OW-gusaru: the synchronous ref-match that card retired had the same window.

The helper in `src/emacs/helper.ts` moves an attachment from H1 to H2, through `reconcile` since OW-gusaru, and sends the `movedFrom` snapshot.
If the buffer is killed, or detached, before agentpane-mode handles that snapshot, its `sessions/detach` names H1.
`forget(session, handle)` then drops nothing, since H1 no longer stands, and H2 stays in `attached` with every notification under it going out to no buffer.
If a buffer is only previewing H2's ref, `agentpane--notified-buffer` in `emacs/agentpane.el` could also route those notifications there.

The helper knows which handle it moved H1 to, so a detach naming a handle it just moved can follow the move.
Whether to keep that link, and for how long, is the executor's call against `forget`'s docblock.

Done when a test in `src/emacs/helper.test.ts` goes red first and green after.
The test moves an attachment from H1 to H2 and then sends `sessions/detach` naming H1. After that, an event under H2 reaches Emacs as nothing.
`bun run check` green.
