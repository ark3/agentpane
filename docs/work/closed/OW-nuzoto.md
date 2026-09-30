---
labels: [change, emacs, sweep-0929]
closed: done
---

# agentpane-mode's let-go and the helper's teardown decide what a detach does by ordering and a timer, where each should read its cause: the server let go, a gap, or a deliberate shutdown

Filed 2026-09-30 to consolidate OW-homogu, OW-rugeba and OW-reyayi's case 2, which the adversarial reads of OW-kutome and OW-pezelo found are one state with several owners, and the case the owner decided on OW-reyayi the same day.
Read against e373676, nothing run.

## The state

A buffer, or a request, loses its helper-side connection for one of three reasons, and each means something different for the turn it was watching:

- **The server let go.** A `session/detached` with `cause: "ended"` (`end` in `src/emacs/helper.ts`), or the helper dying without saying why, which D25 point 4 in `docs/DESIGN.md` takes to mean the server went away (`agentpane--helper-gone` in `emacs/agentpane.el`). The turn is over: a watched turn seen streaming ends as an aborted one does and raises the indicator, and a `sent` watch ends raising nothing (OW-zedawo). This stays exactly as it is.
- **A `seq` gap.** `session/detached` with `cause: "gapped"` (`detachGapped`). The handle stays live on the server and the turn may go on. Nothing is folded into the watch and nothing is raised at the gap, and a `streamed` watch survives it, so a re-attach under the same handle raises the indicator when the turn ends, as the browser's favicon does (`watchSessions` in `src/client/favicon.ts` skips a key with no view and keeps the watch). A `sent` watch is dropped, which keeps the OW-dunahe hazard closed. OW-homogu's body carries both cases and the probes that showed them.
- **A deliberate `agentpane-shutdown`.** The server keeps the agent running: a client's stream closing disposes nothing in `SessionManager` (`src/server/http/session-manager.ts`), so the turn goes on unheard. The owner decided on 2026-09-30 that nothing is raised and the watch is dropped, `streamed` or not; a re-attach after a restart that finds the turn still running raises nothing, a case the owner judged unlikely and cheap to lose.

## What decides it today

On the Emacs side, `agentpane--let-go` takes `&optional gapped` and, when set, calls `agentpane--watch-forget` before `agentpane--read-idle`, so which of two orderings runs is what separates a gap from an `ended` (OW-kutome).
`agentpane--helper-gone` calls it with no argument, so a shutdown raises the indicator as though the server had let go; OW-reyayi's amendment of 2026-09-30 describes that.
`agentpane--read-idle` fabricates a not-streaming status and feeds it through `agentpane--set-status` into `agentpane--watch-turn`, as though the server had sent it, and every cause except `ended` then has to undo that.

On the helper side, `respond` stays silent for any failure once `inFlight.signal.aborted` is set, so the silence is decided by when the request failed, not by why.
To let the replies to requests waiting on a failed first open win that race, `onDisconnect` cancels the input from a `setTimeout` (OW-pezelo), which opens a read window after `stopped` is set; OW-rugeba's body has the case and why it is unreachable today.

## The change

Let each consumer read the cause rather than an ordering.
In Emacs, `agentpane--let-go` takes the cause, and only the server-let-go cause folds a not-streaming status into the watch; the gap keeps a `streamed` watch, and a shutdown drops it.
`agentpane-shutdown` marks the teardown it starts as its own, and `agentpane--helper-gone` passes that on; any other helper death is still the server letting go.
Whether the fabricated status stays for the buffer's display alone, bypassing the watch, or the watch is settled directly, is the implementer's call.
In the helper, `respond` is silent only for a failure the teardown's own abort caused (an `AbortError` from `inFlight`'s signal, or one carrying `inFlight.signal.reason`), and `onDisconnect` cancels the input at once on both paths.
That gives up OW-hiliti's choice that a request failing on its own in the same instant as the abort goes unanswered: such a request now gets its own error, which agentpane-mode already reads as an outcome unknown (`agentpane--request`), not as a refusal.

## Where it is recorded

D25 point 4 in `docs/DESIGN.md` gains the shutdown decision: a deliberate shutdown is not the server letting go, raises nothing, and drops the watch.
The docstrings of `agentpane--let-go`, `agentpane--watch-turn` (whose "a watch on a handle the server has let go of is never read again" is true of `ended`, not of a gap) and `agentpane-shutdown`, and the docblocks of `runHelper` (its "The test is whether the abort has run when the request fails") and `onDisconnect`, say what each cause does.

## Done when

- The `gapped` ordering in `agentpane--let-go` and the `setTimeout` around `reader.cancel()` in `onDisconnect` are both gone.
- ERT tests in `emacs/agentpane-test.el`, each red first: OW-homogu's case A (submit from a buffer no window shows, see it stream, a `session/detached` with `:cause "gapped"`, re-attach under the same handle, stream, stop: the indicator is raised); and `agentpane-shutdown` with a watched turn streaming raises nothing and leaves no watch on the handle.
- Still green: `agentpane-test-turn-done-not-raised-by-a-gap`, `agentpane-test-turn-done-raised-when-the-server-lets-go`, `agentpane-test-turn-done-watch-ends-with-the-helper` and `agentpane-test-shutdown-ends-the-helper`.
- A vitest case in `src/emacs/helper.test.ts` shows a request read after `stopped` sends no fetch or is answered.
- `resources/probes/emacs_helper_no_server_probe.py` still answers 3 of 3, and the two OW-hiliti probes still pass (`resources/probes/README.md`).
- `bun run check` and the ERT suite (`emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`) pass.

OW-fakefe, jsonrpc's exit line overwriting the reason in the echo area, is the same moment but a separate fix, and stays its own card; if this card changes what the teardown writes, say so in OW-fakefe.

## Close note

Landed 2026-09-30 as c6e5d95, 9ffe743, df399ac and e307ab3.

Emacs: `agentpane--let-go` takes a cause symbol — `ended`, `gapped` or `shutdown` — and settles the turn-done watch by it; the gapped ordering is gone.
`ended` (a `session/detached` for the server's end, or any helper death not started by `agentpane-shutdown`) ends a streamed watch raising the indicator and drops a sent one, unchanged.
`gapped` raises nothing, keeps a `streamed` watch (new `agentpane--watch-forget-sent`) so a re-attach under the same handle raises at the turn's end, and drops a `sent` one (OW-dunahe).
`agentpane-shutdown` marks the helper's process (`process-put … 'agentpane-shutdown`), `agentpane--helper-gone` reads the mark and lets go as `shutdown`, and then drops every watch (`agentpane--watch-forget-every`), a gap-kept one on an unattached buffer included — the adversarial read found that watch surviving the shutdown otherwise.
The fabricated idle status now runs after the handle is cleared, so it is display-only.
D25 point 4 in docs/DESIGN.md records the owner's shutdown decision.

Helper: `respond` is silent only for a failure the teardown's abort caused (`abortedHere`: the signal's reason, or an `AbortError` once it fired); the `setTimeout` around `reader.cancel()` in `onDisconnect` is gone, the input cancelled at once on both paths.
Measured under bun 1.4.0 that the old whenever-aborted check was what the timer worked around: cancel at once with the old check answered 0 of 3 no-server probes, with the new check 3 of 3.
The wrapped fetch refuses any call attempted once `stopped` is set, answered "the agentpane helper is exiting".

Verified: new ERT tests `agentpane-test-turn-done-raised-after-a-gap-and-a-reattach`, `-not-raised-by-a-shutdown`, `-not-raised-after-a-gap-before-streaming` and `agentpane-test-shutdown-drops-a-watch-a-gap-kept`, and vitest cases for the post-`stopped` refusal and for `abortedHere`, each shown red first (the before-streaming one against a mutant, since it guards existing behaviour).
`agentpane-test-turn-done-not-raised-by-a-gap` now expects the streamed watch kept ('(nil . t)), which is this card's decision.
All three probes pass (no-server 3/3, drop busy and idle 3/3 each, server death 8/8; Emacs 31.1, bun 1.4.0), recorded in docs/MANUAL_TESTING.md; `bun run check` 1561/1561 and ERT 0 unexpected on main.

Left: a gap-kept watch outlives a kill of its buffer, filed as OW-wufiro; OW-fakefe notes the two new rare dying-helper replies.
