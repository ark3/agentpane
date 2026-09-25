---
labels: [deferral, emacs]
---

# agentpane-mode draws a backlog of session/node once per pipe read that holds one, not once for the whole backlog

OW-tujezi made agentpane-mode record each `session/node` and draw the recorded nodes from a `run-at-time 0` timer (`agentpane--record` and `agentpane--draw-recorded` in `emacs/agentpane.el`), so a backlog handed over in one process-filter call costs one redraw per index.
A backlog larger than one read of the helper's pipe reaches `jsonrpc--process-filter` in several calls, and by the account in `docs/MANUAL_TESTING.md`, "A timer a jsonrpc.el notification handler starts runs after the rest of its chunk (OW-tujezi)", the draw timer started under one read is ripe before the handlers of the next, so such a backlog is drawn once per read that holds a node.
That is read from source and inferred from a timer experiment, not measured on a live backlog.

Deferred on 2026-09-25 because nothing yet shows it costs anything: OW-jeruye caps the helper at one `session/node` per node per 250 ms, and a backlog spanning several reads needs Emacs to fall that far behind.
Worth picking up if agentpane-mode is still observed lagging during a streaming turn after OW-jeruye and OW-tujezi.
An idle timer, or a short non-zero delay, in `agentpane--record` are the obvious levers; the constraint on either is that every non-snapshot notification must still find the recorded nodes drawn before it is handled, which `agentpane--on-notification` already guarantees independently of the timer.

Done: a batch test or a recorded live run that feeds a backlog across more than one process-filter call shows how many redraws it costs before and after, with the change's cost to latency stated beside it.
