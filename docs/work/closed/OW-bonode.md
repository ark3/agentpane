---
labels: [deferral, emacs, emacs-native]
closed: done
---

# The Emacs helper connection uses synchronous jsonrpc-request, which nests once notifications flow and never closes the helper on shutdown

Filed 2026-09-22 from the adversarial review of OW-wavone, where neither concern is reachable, and both become live in OW-gunuke, the slice that attaches a session and so opens the helper's event stream.

Everything in `emacs/agentpane.el` goes through `agentpane--request`, a `jsonrpc-request` that blocks in `accept-process-output` until the reply lands.
The `sessions/changed` handler in `agentpane--on-notification` schedules `agentpane--revert-pickers` through `run-at-time 0`, and that refetch is itself a synchronous `sessions/list`.
Read against `jsonrpc.el` 1.0.29 on Emacs 31.1: a timer firing while an outer request is waiting nests a second `jsonrpc-request`; when the outer reply arrives, its `throw` unwinds through the inner request's `unwind-protect`, which removes the inner continuation, and the picker refetch is dropped silently.
This was read, not provoked; the first thing this card does is build a harness that provokes it, or shows it cannot happen.
The likely repair is `jsonrpc-async-request` with a callback for every request the mode makes, which OW-gunuke's streaming buffer wants anyway.

Second, `jsonrpc-shutdown` on the connection warns that the sentinel has not run: the helper (`src/emacs/main.ts`) exits only when its stdin closes, and `jsonrpc-shutdown` does not close it.
Nothing in OW-wavone calls shutdown, so this cost nothing there; a slice that restarts or quits the helper needs to close stdin (`process-send-eof`) before or instead of shutdown.

Done when a test or a recorded batch run shows the nested case handled, either because the requests are asynchronous or because the harness proved the drop cannot occur, and a helper started by the mode is gone from the process table after the mode's own shutdown path runs.

## Close note

Landed a3e4dd9..4443d2a on main, measured 2026-09-22 on Emacs 31.1, jsonrpc.el 1.0.29, bun 1.4.0.

The predicted drop does not happen: jsonrpc.el 1.0.29 parks an outer reply that arrives during a nested request as an "anxious continuation" and runs it after the inner one, so the picker refetch did land.
What happened instead is a stall: the outer `jsonrpc-request` returned only at its own timeout's deadline (10.07s with both replies in by 0.3s, 3.07s with the timeout set to 3).
Every request the mode makes is now `jsonrpc-async-request` with a callback, guarded so a buffer draws only its latest request's reply, since the helper answers concurrently.
The ert tests `agentpane-test-nested-refetch-*` failed against 7b35eab at about 10s and pass in under a second; `agentpane-test-stale-reply-does-not-overwrite` fails with the guard removed.

`agentpane-shutdown` closes the helper's stdin, then calls `jsonrpc-shutdown`; `agentpane-test-shutdown-ends-the-helper` starts the real helper through the mode and asserts it exited with code 0 and its pid is gone, and fails without the `process-send-eof`.
An HTTP request still in flight keeps the helper alive past stdin close, so shutdown then falls back to jsonrpc's SIGKILL: filed as OW-kofuda.
Evidence is in `docs/MANUAL_TESTING.md`, "The Emacs helper connection: a nested request stalls, and the helper exits on stdin close (OW-bonode)".
