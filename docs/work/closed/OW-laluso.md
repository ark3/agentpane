---
labels: [defect, emacs]
closed: moot
---

# A helper's death leaves older requests unanswered when a synchronous request is out: jsonrpc.el's sentinel throws out of its error-handler walk, so agentpane--sending and its siblings stay set for good

Found 2026-09-28 by the adversarial read of OW-bukupu's third cut, reproduced in batch Emacs 31.1 against a fake helper, on main before OW-bukupu and after it alike, so not a regression.
In service of OW-bukupu's promise, in `agentpane--request`'s docstring ("Each request has one answer, the first of its reply, its timeout and its helper's death"), which this case breaks: here a request gets none of the three.

## The cause

`jsonrpc--process-sentinel` in `/usr/share/emacs/31.1/lisp/jsonrpc.el.gz` (jsonrpc.el 1.0.29) cancels every pending request's timeout timer, then calls each pending request's error handler with "Server died", newest first.
The error handler of a synchronous `jsonrpc-request` throws to that request's catch tag, which unwinds out of the walk, so every older asynchronous request is skipped: its timer is already cancelled, its reply will never come, and its error handler never runs.
`:on-shutdown` still runs, from the sentinel's `unwind-protect` cleanup, so the teardown (`agentpane--helper-exited`, `agentpane--helper-gone` in `emacs/agentpane.el`) happens, but it fails no requests.

## What it costs

A request whose FAILED clears a buffer flag leaves the flag set until the buffer is killed.
The reader drove it end to end: attach, `agentpane-send`, then a synchronous request, then the helper dies with no reply; after the teardown `agentpane--sending` is still t and every later send answers "A prompt to this session is already being sent".
By reading, `agentpane--attaching` (`g` answers "still attaching"), `agentpane--closing` and `agentpane--forking` wedge the same way, and a prompt's turn-done watch is never forgotten.
The synchronous requests are `agentpane--attach-now` (up to `agentpane--spawn-timeout`), `sessions/create` in `agentpane-new-session`, and the `models/list` reads in `agentpane--read-model` and `agentpane--read-effort`; a server dying during `agentpane-new-session` while another buffer's prompt is in flight is enough.

## Reproducing

An async `sessions/prompt` through `agentpane--request`, then a synchronous `jsonrpc-request` on the same connection, with a helper that reads both and exits without replying: count the prompt's FAILED and UNSENT calls after the teardown and read `(jsonrpc--continuations connection)`; both counts are 0 and continuation 1 is still pending.
Build the connection as the tests around `agentpane-test-late-error-reply-fails-once` in `emacs/agentpane-test.el` do.

## Done when

An ERT test in `emacs/agentpane-test.el` drives that order through a real process and asserts the async request fails exactly once, and that `agentpane--sending` is clear after the teardown; red before, green after.
Whatever answers the skipped requests owns them per connection rather than re-walking jsonrpc.el's internals at the site; the teardown in `agentpane--helper-gone` is the natural owner, since it runs whatever the walk did.
The suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Moot under D25's "What the run found, and the two ownership changes it asked for" (2026-09-28): OW-mopuyi makes the teardown answer every request the dead helper had out, whatever jsonrpc.el's walk reached, and clear each served buffer's in-flight flags; this card's ordering is OW-mopuyi's red-first test, extended to `agentpane--attaching`.
