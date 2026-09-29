---
labels: [deferral, emacs]
closed: moot
---

# agentpane-close-session leaves a never-prompted session's buffer standing when the listing after the close fails, so g previews it empty and a send attaches a ref the server no longer holds

Found by the adversarial read of OW-watawe on 2026-09-28, by reading; not reproduced.
Left because it takes the helper's `sessions/list` failing or timing out in the moment after a close, and the draft is kept either way, since the buffer lives.

`agentpane-close-session` in `emacs/agentpane.el`, once `sessions/close` answers, asks `sessions/list` to decide between redrawing the buffer from its stored transcript (`agentpane-refetch`) and killing it for having nothing on disk (OW-vasubu).
When that listing fails, the request's FAILED clears `agentpane--closing` and does nothing else, so the buffer stays holding no handle and unattached, and whether the session is on disk is never learned.
For a session created or forked and never prompted, that is the state the kill exists to avoid: `g` sends `sessions/preview`, which answers the ref with an empty transcript rather than an error, and a send could only attach a ref the server no longer holds.
The test `agentpane-test-close-session-listing-that-fails-frees-the-buffer` in `emacs/agentpane-test.el` asserts exactly that `g` previews, so a change here changes that test's intent, not only its assertions.

In service of a closed session's buffer ending in the state the listing would have chosen, or saying plainly that it could not tell.
Which remedy fits -- retry the listing, report the failure in the echo area and leave the buffer marked as not knowing, or decide from what the buffer already knows (a fork or virtual session it created and never prompted) -- is open.

Done when an ERT test built on the `agentpane-test--closing` macro holds the `sessions/list` reply, fails it, and asserts the chosen outcome, red before the change and green after.

## Close note

Folded 2026-09-29 into OW-vugefa by OW-zavehi's decision, D26 in `docs/DESIGN.md`, point 7.
`agentpane-close-session` asks no listing under D26: once the close answers it previews, and a preview answered `404` `gone` (OW-royosa) kills the buffer with the composer text on the kill ring, so the failed listing this card was about no longer exists.
OW-vugefa's done-condition carries the case, built on the `agentpane-test--closing` macro, and replaces `agentpane-test-close-session-listing-that-fails-frees-the-buffer`'s intent.
