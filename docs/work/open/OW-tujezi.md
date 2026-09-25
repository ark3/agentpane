---
labels: [change, emacs]
---

# agentpane-mode redraws a node once per session/node it receives, so a backlog of them costs one full node redraw each where one redraw of the latest would do

Owner, 2026-09-25: agentpane-mode gets laggy while a turn streams.
OW-jeruye fixes the steady rate in the helper, at most one `session/node` per node per 250 ms; this card is its Emacs-side sibling, filed at the owner's request as separate work, and covers what that cannot: when Emacs falls behind, every notification queued behind the one it is handling still costs a full redraw of its node.

## Where the redraws happen

`agentpane--on-notification` in `emacs/agentpane.el` handles `session/node` by calling `agentpane--upsert` at once, which `ewoc-invalidate`s the node, redrawing all of it -- shr for every text part and `agentpane--fit-header` for every tool and thinking header.
Measured 2026-09-25: 2–6 ms per redraw in batch Emacs for nodes of 2,600–8,300 characters, and roughly twice that in the owner's graphical frame, going by `string-pixel-width` there (OW-tujula); redisplay not measured.
The node carries the whole message, so a node superseded before it was drawn is wasted work in full.

How the notifications arrive, read from `jsonrpc.el` 1.0.29 as shipped with Emacs 31.1 on the home server (`/usr/share/emacs/31.1/lisp/jsonrpc.el.gz`): `jsonrpc--process-filter` parses every complete message in the chunk it is given and schedules each one's `jsonrpc-connection-receive` in a timer of its own, all sharing one time object so they run in order ("the time object is reused for each timer").
So a backlog reaches `agentpane--on-notification` as a run of timers, one notification each.
That a timer this handler starts with `run-at-time 0` during that run fires after the rest of it follows from `timer-activate` ordering timers by time, and is read from the source, not observed; the implementer confirms it.

## The change

A `session/node` records the latest node for its index in its buffer and schedules one redraw, and that redraw draws each recorded node once, however many arrived since the last one.
Load-bearing:
- Any other notification for the buffer draws what is recorded before it is handled itself -- `session/snapshot`, `session/status`, `session/error`, `session/request`, `session/requestResolved`, `session/notice`, `session/renamed` -- so the order `agentpane--set-status` and `agentpane--upsert` rely on is kept, as OW-jeruye keeps it on the helper's side.
- A node at a new index is appended in arrival order relative to the others, since `agentpane--upsert` appends by arrival and redraws the one before it as no longer the pending turn.
- Nothing recorded survives the buffer: a kill or a snapshot's full redraw discards it rather than drawing it afterwards.
- Point, window start and the draft behave as they do now for a drawn node (`agentpane--above-prompt`).
Whether the redraw is a zero-delay timer, an idle timer, or something else is the implementer's call, stated in the close note with what was measured to settle it.

## Done

Red first, then green, in `emacs/agentpane-test.el`: several `session/node` notifications for one index, handed to `agentpane--on-notification` before timers run, redraw the node once and draw the last one's content; a `session/status` arriving after a recorded node finds that node drawn before the status is applied; and a recorded node for a buffer killed before the redraw raises nothing and draws nothing.
The batch suite passes as the Commentary of `emacs/agentpane.el` gives it, with its pass count updated.
