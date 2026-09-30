---
labels: [deferral, emacs]
---

# An ERT test that fails partway through a helper's death leaves its teardown's answers pending, and they land in the next test's captured messages

Filed 2026-09-29 from OW-hiliti's adversarial read.
Judged not worth holding OW-hiliti for: it only bites when a test is already failing, and then it can misattribute the failure.

## What happens

`agentpane--answer-deaths` in `emacs/agentpane.el` answers a dead helper's requests from a zero-delay timer.
When an ERT test such as `agentpane-test-no-request-before-the-teardown` in `emacs/agentpane-test.el` fails before `agentpane-test--heard-out` has let that timer run, its pending "agentpane: sessions/list failed: the helper exited" lands in the next test.
There, `agentpane-test--noting` captures it in `said`, and the reader saw it falsely fail `agentpane-test-late-error-reply-fails-once`, which passes 6 of 6 when run alone.

## Done when

A test that fails partway through a helper's death leaves nothing that runs in the next test: for example, `agentpane-test--outliving` or `agentpane-test--noting` drains or cancels the teardown's timers on the way out.
To show it, make one such test fail on purpose (throwaway) ahead of `agentpane-test-late-error-reply-fails-once` and watch only the deliberate failure go red.
The ERT suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
