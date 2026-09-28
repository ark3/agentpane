---
labels: [deferral, emacs]
closed: moot
---

# An attach reply jsonrpc.el held back behind a synchronous request arrives after its helper's teardown and binds the buffer to nothing, or to the next helper, which forwards nothing under that handle

Recorded 2026-09-28 as the accepted cost of OW-bukupu's design, in `agentpane--request`'s docstring in `emacs/agentpane.el` (the paragraph beginning "Each request has one answer"), and widened by the adversarial read of its third cut.
Judged not worth holding OW-bukupu for: it needs a helper to die while a synchronous request is out and an attach's reply is held behind it.

## The cause

jsonrpc.el 1.0.29 on Emacs 31.1 holds the reply to an asynchronous request that arrives while a synchronous `jsonrpc-request` is out as an "anxious continuation" (`docs/MANUAL_TESTING.md`, "jsonrpc.el runs an async reply after later notifications"), and `jsonrpc--continue` re-queues it with `run-at-time 0` only after that request returns.
The held reply is no pending request to the sentinel, so it gets no "Server died", and it is handed on after the teardown `agentpane--helper-exited` defers, where `agentpane--request` still takes it as the answer.
`agentpane--attached-as` then binds the buffer to `agentpane--connection`, whatever that is by then.

## The two outcomes

1. No helper started since: the global is nil, so the buffer holds the dead helper's handle, neither attached nor dropped, and a prompt waiting on the attach starts the next helper and goes out through it.
2. Several replies held: jsonrpc re-queues them newest first, so the first one's waiter can start helper B, and the next attach reply then binds its buffer to B, with `agentpane--attached-p` true under a handle B never attached; a prompt from that buffer skips the attach and goes out through B, which forwards nothing.
   Reproduced by the reader with two buffers each sending an attach, both replies held behind a synchronous request as the helper dies.

In both, the waiting prompt's turn-done watch stays armed, by reading; `g` re-attaches, and in outcome 2 B's own teardown lets the buffer go.
OW-tifiva is the same shape from another trigger, a reply landing after the helper detached a gapped session; read it before choosing an owner, since one fix may serve both.

## Done when

An ERT test in `emacs/agentpane-test.el` holds an attach reply behind a synchronous request as a real helper process dies, for each outcome, and asserts the buffer ends not attached, holding no handle, and dropped, with no prompt sent; red before, green after.
The paragraph naming this as an accepted cost in `agentpane--request`'s docstring is removed or rewritten to match.
The suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Moot under D25's "What the run found, and the two ownership changes it asked for" (2026-09-28): OW-rebawa stops the attach reply binding anything, so a reply jsonrpc.el held behind a synchronous request binds nothing when it arrives after its helper's death; both of this card's outcomes are OW-rebawa's red-first tests, and the synchronous requests stay.
