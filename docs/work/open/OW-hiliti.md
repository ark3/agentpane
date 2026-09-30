---
labels: [defect, emacs, sweep-0929]
---

# agentpane-mode answers a request around its helper's death by the death, not by what the helper wrote, so a refused prompt keeps its turn-done watch, a server-unreachable reason never shows, and chained work errors from a timer

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
It is meant to supersede OW-bonuhi and, probably, OW-kimafi, and it is the Emacs half OW-pezelo's helper-side fix cannot reach the user without.

## Three owners of one answer

- `agentpane--request` in `emacs/agentpane.el`: its `:error-fn` ignores any error once `(jsonrpc-running-p connection)` is nil ("Past the helper's death, the teardown answers").
  Its docstring states the rule outright: "An error reply among them is handled once the helper reads as dead, so the request fails as the death, running FAILED alone, and the helper's own message is not shown."
- `agentpane--connection` signals "The agentpane helper has exited" for a helper that has exited but whose teardown has not yet run, which is what OW-kimafi's "Error running timer" noise comes from when a callback chains a request off the dead helper's last messages.
- `runHelper`'s teardown in `src/emacs/helper.ts` aborts every request in flight, which is OW-pezelo's "The operation was aborted.".

## Read the why first

The rule in `agentpane--request`'s docstring was chosen, not drifted into: the same docstring records that treating an error reply as ordinary ran the error handler twice (OW-bukupu), threw out of jsonrpc.el's handler walk so an older synchronous request got no answer (OW-laluso), and abandoned a turn-done watch (OW-zedawo), all measured on Emacs 31.1 with jsonrpc.el 1.0.29 on 2026-09-28 under OW-mopuyi.
A fix that reintroduces any of those is not this card.
jsonrpc.el's own death error is distinguishable from a reply the helper wrote: `jsonrpc--process-sentinel` answers with `(:code -1 :message "Server died")`.

## The rule proposed

1. A reply the helper actually wrote, error or not, is the request's answer, handled once; the teardown answers only what is still out.
2. A request refused because the helper has exited is recorded as out and answered quietly by the teardown, rather than signalling from `agentpane--connection`.

OW-pezelo was filed before OW-mopuyi landed, so its account of what Emacs shows predates rule 1's opposite; the sweep's reader expects Emacs now shows "failed: the helper exited", unverified.
Under this card, the helper-side half of OW-pezelo (answer the opening request with the server being unreachable) is what makes that reason reach the echo area.

## Done when

ERT tests in `emacs/agentpane-test.el`, each red first:
- a prompt refused by an error reply the helper wrote just before dying clears its turn-done watch, and the teardown raises no indicator for it (OW-bonuhi's case);
- the error reply's own message is what the user is shown;
- a fork callback chained off a dead helper's last reply issues no request that signals from a timer, and the fork buffer is shown or its failure said once (OW-kimafi's case);
- OW-bukupu's, OW-laluso's and OW-zedawo's existing tests still pass.
Then OW-bonuhi closes `--moot` citing this card, OW-kimafi closes `--moot` or is amended to what remains, and OW-pezelo is amended to its `src/emacs/helper.ts` half.

## Amended 2026-09-29 at execution

The adversarial read of the first cut found rule 1 false as the helper stood: `runHelper` in `src/emacs/helper.ts` aborts `inFlight` at its teardown, and `respond`'s catch then writes `-32603 "The operation was aborted."` for every request still waiting, which the helper's test "aborts a request still waiting on the server when the input ends, and answers it with the abort" asserts.
Read as the request's answer under rule 1, that reply runs UNSENT, so a prompt whose turn this Emacs saw streaming loses its watch at every stream drop Emacs is busy through, which is OW-zedawo back; the reader reproduced it against the real helper (bun 1.4.0, Emacs 31.1, jsonrpc.el 1.0.29), 3 of 3 runs on the first cut and 0 of 3 on `main`.
So this card now also owns the helper's half of rule 1: a request the helper aborts at its own teardown gets no reply from it, and Emacs's teardown answers it as the death.
OW-pezelo keeps its question, what the request that opened the helper is answered with when the first open fails; after this card that request gets no reply unless OW-pezelo gives it one.

The same read found that a request made in the gap, recorded for the teardown, lost UNSENT, which `agentpane--failing` had run when `agentpane--connection` signalled: a prompt whose attach answered while the helper lived and whose request came after its death kept a watch that `agentpane--let-go`, running a tick before `agentpane--answer-deaths`, ended by raising the indicator for a turn from elsewhere.
A request sent nowhere reached no backend, so its UNSENT runs at once; its FAILED stays the teardown's.

Added to "Done when": a test in `src/emacs/helper.test.ts`, red first, that a request aborted by the helper's teardown gets no reply, with `bun run check` passing; and an ERT test, red first, that a prompt made in the gap on a session seen streaming leaves no turn-done indicator.
