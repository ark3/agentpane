---
labels: [deferral, emacs]
---

# A preview still out when agentpane--attach-now attaches its buffer synchronously draws the stored transcript over the live one, since that attach does not supersede it

Found by the adversarial read of OW-vugefa on 2026-09-29; it predates that card.

`agentpane--request` in `emacs/agentpane.el` runs a reply's CALLBACK, and since OW-vugefa its ERRED, only while the request is still `agentpane--latest-request`, so a later request supersedes an earlier one's reply.
`agentpane--attach-now` attaches through a synchronous `jsonrpc-request`, not through `agentpane--request`, and sets no `agentpane--latest-request`.
It runs from the interactive specs of `agentpane-set-model` and `agentpane-set-effort` on a buffer not attached.

The ordering: in a buffer not attached, `g` (`agentpane-refetch`) sends `sessions/preview`; before it answers, `M-x agentpane-set-model` attaches the buffer synchronously and a snapshot draws the live transcript; the preview's reply then arrives, is still the latest request, and `agentpane--draw`s the stored transcript over the live one.
A preview answered `gone` in that window would kill the now-attached buffer through `agentpane--gone`, but that needs the attach to succeed on a ref the server just answered `gone` for, which nothing on the server allows.
The reader also named a second route that attaches with no request of the buffer's own: a snapshot whose `askedFor` matches a buffer with `agentpane--attach-sent` set after its attach timed out.

In service of D26 point 7's "a buffer is live exactly when attached": no reply to a preview should redraw or kill a buffer that is attached.
Judged not worth blocking on because it needs a `g` and a synchronous attach within one preview's round trip.

Done when an ERT test in `emacs/agentpane-test.el` that sends a preview, attaches through `agentpane--attach-now`, and then delivers the preview's reply goes red first and green after, the buffer keeping the snapshot's nodes.
Whether the fix makes the synchronous attach supersede outstanding requests or makes the preview's handlers read `agentpane--attached-p` is the implementer's call; a guard in the handlers alone should say in its docstring which routes make it reachable.
