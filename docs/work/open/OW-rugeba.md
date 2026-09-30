---
labels: [change, emacs]
---

# The Emacs helper's respond goes silent by when a request failed, not by why, so a failed first open cancels its input from a timer to let the replies win the race

Filed 2026-09-29 by OW-pezelo's adversarial read, as the check its fix added where the symptom showed.

## The check

`respond` in `src/emacs/helper.ts` writes no reply for a request that failed once `inFlight.signal.aborted` is set (OW-hiliti; the docblock above `runHelper` says "The test is whether the abort has run when the request fails").
OW-pezelo made a failed first open reject the open promise so the requests waiting on it answer "could not reach the agentpane server"; because silence is decided by timing, `onDisconnect` there cancels the stdin reader from `setTimeout` rather than at once, so the rejection's microtask chain writes each reply before the teardown's `inFlight.abort()`.
Cancelled at once, bun 1.4.0 wrote neither reply, 3 of 3, while node wrote both (`docs/MANUAL_TESTING.md`, the OW-pezelo section); only `resources/probes/emacs_helper_no_server_probe.py` goes red for it, and the vitest case in `src/emacs/helper.test.ts` does not.

## A case it misses

The timer opens a read window after `stopped` is set: a request read in it is handled as if the helper were live.
A `sessions/prompt` read there sends its `POST`, and the teardown then aborts it with no reply, so agentpane-mode reads it as the death though the prompt may have reached a server.
The read found this unreachable today against a real down server, since `agentpane--attached-then` sends a prompt only after its attach answers and the server never answers the helper's events GET with a non-200 (`isTrustedRequestMetadata` in `src/server/http/app.ts`); it is the timer's cost, not an observed failure.

## What to change

Make the silence owned by its cause: `respond` stays silent only for a failure the helper's own abort caused (an `AbortError` from `inFlight`'s signal, or matching `inFlight.signal.reason`), so any other failure is answered whenever it lands, and `onDisconnect` cancels the input at once on both paths.
This gives up OW-hiliti's choice that a request failing on its own "in the same instant" as the abort goes unanswered too; weigh that against the `emacs_helper_server_death_probe.el` measurement the docblock cites before choosing, and record the choice in that docblock.

## Done when

The `setTimeout` around `reader.cancel()` in `onDisconnect` is gone, and the input is cancelled at once on a failed first open as on a drop.
`resources/probes/emacs_helper_no_server_probe.py` still answers 3 of 3, the two OW-hiliti probes still pass (`resources/probes/README.md`), a vitest case shows a request read after `stopped` sends no fetch or is answered, and `bun run check` passes.
