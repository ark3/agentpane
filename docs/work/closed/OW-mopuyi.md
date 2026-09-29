---
labels: [change, emacs, d25]
closed: done
---

# agentpane-mode clears a buffer's in-flight flags only from each request's own error handler, which jsonrpc.el skips or runs too early at a helper's death; the teardown should answer every request the dead helper had out

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, section "What the run found, and the two ownership changes it asked for", which the owner took that day; read it first.
OW-laluso and OW-zedawo closed moot into this card; each names an ordering its tests must cover, with a reproduction worth reading.

## What happens

Each buffer's in-flight state is cleared by the failure path of the request that set it: `agentpane--sending`, `agentpane--attaching`, `agentpane--closing` and `agentpane--forking`, and the prompt's turn-done watch, which a request that reached no backend abandons as UNSENT (`agentpane--request`, `agentpane--watch-turn` in `emacs/agentpane.el`).
At a helper's death those failure paths are jsonrpc.el's to run, and as of jsonrpc.el 1.0.29 on Emacs 31.1 (`jsonrpc--process-sentinel` in `/usr/share/emacs/31.1/lisp/jsonrpc.el.gz`) it runs them unreliably for this purpose:

- OW-laluso: the sentinel calls each pending request's error handler with "Server died", newest first; a synchronous request's handler throws out of that walk, so every older asynchronous request gets no answer at all, and its flag stays set until the buffer is killed ("A prompt to this session is already being sent" for good).
- OW-zedawo, its case 2 (case 1 was settled by OW-bukupu): a prompt whose turn the buffer has already seen streaming is answered "Server died", read as UNSENT, and its watch is abandoned before the teardown could fold it, so the turn-done indicator is never raised.

`agentpane--helper-gone` runs whatever the walk did, from `:on-shutdown` in the sentinel's cleanup and behind the helper's last messages since OW-bukupu (`agentpane--helper-exited`).

## The change

The teardown owns what a helper's death does to the requests and buffers it served.
Under D25 point 4 a death means every buffer that helper served is detached, so it answers every request that connection still has outstanding, once, through the same one-answer path OW-bukupu gave `agentpane--request` ("Each request has one answer, the first of its reply, its timeout and its helper's death"), whether or not jsonrpc.el reached it; an answer jsonrpc.el delivers too is then a no-op.
It clears each served buffer's in-flight flags, and it decides the turn-done watch itself: a watch that saw the turn streaming raises the indicator as an aborted turn does, and one that saw nothing is forgotten.
A "Server died" from jsonrpc.el is no longer read as "reached no backend"; the teardown's answer is what a request's failure path sees at a death.
Per-request handlers stay the owner for every failure that is not a death.
OW-reyayi asks whether a buffer with a close in flight should end dropped, and whether a deliberate `agentpane-shutdown` should raise turn-done; this card keeps today's outcome for both unless OW-reyayi has closed with a decision, which it then follows.

## Done when

ERT tests in `emacs/agentpane-test.el`, each through a real process connection as the tests around `agentpane-test-late-error-reply-fails-once` build one, without stubbing `jsonrpc-async-request`, red first:

- OW-laluso's ordering: an async `sessions/prompt`, then a synchronous request, then the helper exits with no reply; the prompt's failure path runs exactly once and `agentpane--sending` is clear after the teardown; and the same for `agentpane--attaching` through an async attach.
- OW-zedawo's case 2: a prompt sent, a `session/status` with `isStreaming t` under its handle, then the helper dies with the reply held; the turn-done indicator is raised.

The suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`, and `bun run check` if anything under `src/` changes.

## Close note

Done 2026-09-28, landed as 63193be.
`agentpane--request` in `emacs/agentpane.el` records each request in `agentpane--requests-out` under its connection. `agentpane--helper-gone` forgets the connection and lets go of the served buffers at once, then answers every request still recorded, oldest first, from a zero-delay timer of its own (`agentpane--answer-deaths`), running its FAILED and never its UNSENT.
A request's error handler past the death answers nothing, "Server died" included.
The one-tick delay is deliberate: a reply jsonrpc.el held back behind a synchronous request (an anxious continuation) is handed on from a timer queued between the teardown and the answers, so it is still the answer (Emacs 31.1, jsonrpc.el 1.0.29, measured 2026-09-28). The first cut answered inside the teardown and dropped that reply, which left an admitted prompt holding its draft.
Verified by three new ERT tests through real processes, each red on the old code: `agentpane-test-death-answers-a-prompt-behind-a-synchronous-request` and `agentpane-test-death-answers-an-attach-behind-a-synchronous-request` (OW-laluso's ordering), and `agentpane-test-death-ends-a-turn-seen-streaming` (OW-zedawo case 2).
`agentpane-test-late-error-reply-fails-once` now asserts unsents 0. `agentpane-test--heard-out` also waits for the connection's recorded requests to drain.
Full ERT suite green: 218 tests, 3 skipped. Nothing under `src/` changed.
OW-reyayi's two cases keep today's outcome: a close in flight still ends dropped, and `agentpane-shutdown` still raises turn-done for a turn seen streaming.
The adversarial read found a narrow reclassification, a refusal read at the death answered as the death, filed as OW-bonuhi.
It also noted that one FAILED signalling would strand the requests after it in the loop. No FAILED signals today, so no guard was added.
