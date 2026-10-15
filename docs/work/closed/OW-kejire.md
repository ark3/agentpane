---
labels: [defect, emacs]
closed: done
---

# agentpane-mode drops a handled prompt's turn watch only in the prompt's reply callback, so a merge before the reply, a reply past the timeout, or a turn seen before the reply escapes it

Filed 2026-10-14 from the adversarial read of OW-taviju (commit "emacs: a prompt the backend handled drops this buffer's turn watch and says no turn started (OW-taviju)"); cases (1) and (3) were confirmed by running probe ERT tests, case (2) by reading.

OW-taviju made `agentpane--send-prompt` in `emacs/agentpane.el` abandon the turn-done watch its prompt armed when `sessions/prompt` answers `(:disposition "handled")` -- a Pi extension command such as `/mcp` that starts no turn.
The abandon is a check in the prompt's success callback, the site where the symptom showed, while the watch itself lives in the global `agentpane--turn-watches`, keyed by handle (`agentpane--watch-submit`, `agentpane--watch-turn`).
It misses three cases, each leaving the indicator raised for a turn this Emacs did not ask for:

1. A merge (`agentpane--absorb`) kills the sending buffer before the handled reply arrives.
   `agentpane--request` runs no success callback for a killed buffer, while its UNSENT path, which a refusal takes, runs whether or not the buffer lives, so the watch stays `sent` on the handle the survivor holds and the next turn from elsewhere raises the indicator.
   Reproduced by adapting `agentpane-test-turn-done-abandoned-by-a-refusal-after-a-merge` in `emacs/agentpane-test.el` to answer handled after the holder is killed.
2. A handled reply that outlasts `agentpane--spawn-timeout` is discarded, so the watch stays `sent`, as the `agentpane--send-prompt` docblock already accepts for a timed-out prompt in general; nothing there extends that to the handled case, and the draft and the "handled" line are not updated either.
3. On `pi 1.2.0` an extension command's handler runs before Pi answers `handled`, so a handler that starts a turn through `pi.sendUserMessage` (Pi's `/ask` example) streams that turn before the reply, and another client's turn can likewise beat it.
   A turn that starts and ends before the reply has already raised the indicator, which the abandon at the reply cannot undo; one still streaming at the reply is dropped as decided.
   The `agentpane--send-prompt` docblock carries the caveat since OW-taviju; this card decides what that order does.

The browser has the same answer-after-events case at `disarmSubmit` in `src/client/App.svelte`, and OW-zikiga owns it there; whatever this card decides for the order should match what OW-zikiga records in `disarmSubmit`'s docblock (`AGENTS.md`, "Both clients"), so read OW-zikiga's close note if it has closed.

The fix moves the handled outcome to the owner of the watch rather than the reply site: the watch, or `agentpane--request`'s outcome handling, learns that its prompt was handled whether or not the sending buffer still lives, and the decision for the events-before-reply order is recorded in the `agentpane--send-prompt` and `agentpane--watch-submit` docblocks.

## Done when

ERT tests in `emacs/agentpane-test.el`, each red first, cover case 1 (a handled reply after a merge killed the sender raises nothing at the next turn from elsewhere) and case 3 (a turn's events before a handled reply do whatever the docblock now says), and case 2 is either covered by a test or its cost stated in the `agentpane--send-prompt` docblock beside the timed-out prompt's.
The abandon in `agentpane--send-prompt`'s success callback is gone, replaced by the owner's handling, not joined by a second check.
The suite passes under `emacs --batch -L emacs -l ert -l agentpane -l emacs/agentpane-test.el -f ert-run-tests-batch-and-exit`, which `bun run check` does not run.

## Close note

Landed in fc190c0a ("emacs: a handled prompt's answer drops its turn watch from the request's reply, whatever became of the buffer"); emacs/ only, so `bun run check` was not needed.
Routing: `agentpane--request` takes a new last argument, REPLIED, UNSENT's counterpart for a reply: it runs with the result on every successful reply, before CALLBACK, whether or not the buffer lives or has sent a later request since.
`agentpane--send-prompt` moved its handled-answer abandon there; the abandon in the success callback is gone, and the callback keeps only the buffer-local "handled" line (`agentpane--hold-handled`).
Abandon stays by identity (`agentpane--watch-abandon`).
Case 3 decision, matching OW-zikiga's `disarmSubmit`, recorded in the `agentpane--send-prompt` and `agentpane--watch-submit` docblocks: the handled answer drops the watch its prompt armed whether `sent` or `streamed`, so a turn still streaming at the answer raises nothing at its end; a turn that ended before the answer has raised the indicator, and that stays.
Case 2 is stated, not tested, beside the timed-out prompt's paragraph: a handled reply past `agentpane--spawn-timeout` is discarded, so its watch stays `sent` and the next turn from anywhere raises the indicator, its draft stays, and no handled line shows.
Tests in `emacs/agentpane-test.el`, tagged OW-kejire: `agentpane-test-turn-done-abandoned-by-a-handled-answer-after-a-merge` (case 1, red against 0a6bc94d's `agentpane.el`, checked by the dispatching session), `agentpane-test-turn-done-dropped-by-a-handled-answer-after-streaming` and `agentpane-test-turn-done-kept-raised-by-a-handled-answer-after-the-turn` (case 3; green on the base, which already behaved so, and shown red under mutations: abandon dropping only `sent` watches, abandon by handle, clearing `agentpane--turns-done` at the answer — the first re-checked by the dispatching session).
ERT suite on main: 261 ran, 0 unexpected, 3 unrelated skips.
The adversarial read confirmed, by a probe, that identity cannot see a join: after a merge the survivor can send while the killed holder's prompt is out, join its watch, and lose it to that prompt's handled answer (a regression from base, which only skipped the dead buffer's callback) or refusal (already broken on base, from OW-dunahe).
That went to OW-kakasu, which replaces identity with claims on the watch; 4f178e07 names the gap in the `agentpane--watch-submit` docblock.
Not run in Emacs against a live Pi.
