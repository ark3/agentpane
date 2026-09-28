---
labels: [defect, emacs]
closed: done
---

# agentpane-close-session leaves its buffer attached while the close is in flight, so g, C-RET, f and a second C-c C-q all go ahead and can respawn the session being closed

Found by the adversarial read of OW-yosege on 2026-09-27, which added `agentpane-close-session` (`C-c C-q`) to `emacs/agentpane.el`.

That command sends `sessions/close` and changes the buffer's state only in the close's reply callback: until then the buffer still counts as attached (`agentpane--attached-p`) and holds its handle.
The close is not quick: `SessionManager.close` in `src/server/http/session-manager.ts` takes the session out of the server's table first and then awaits the subprocess's disposal, up to about a second plus a SIGKILL, and the helper's `forget` (`sessions/close` in `src/emacs/helper.ts`) runs only after that.

In that window every attached-buffer command still goes ahead, and the reviewer confirmed each against stubs:
- `g` (`agentpane-refetch`) sends `sessions/attach`. The close's `forget` deletes that attach's `pending` entry in the helper, and if the attach reaches the server during disposal the server spawns a fresh container; the helper never records it, while Emacs takes the handle from the reply and counts itself attached — stranded, its turns never forwarded.
- `C-RET` (`agentpane-send`) sends `sessions/prompt`, whose route attaches first (`src/server/http/app.ts`), respawning the session and running a turn nobody sees; the buffer then lands on a preview.
- `f` (`agentpane-fork`) and `e` fetching fork points do the same through their attach-first routes.
- A second `C-c C-q` sends a second `sessions/close`.
The command refuses an attach already in flight when it is pressed (its `agentpane--attaching` clause), which is the one ordering it covers; it says nothing about an attach sent after it.

A second, smaller gap of the same kind: `agentpane-compact` sets no local state when it sends, so a close pressed between the compact request and the first `session/status` carrying `:compaction` is allowed, where the browser refuses it because `controller.ts` marks the compaction `"requesting"` from the click (`compact` in `src/client/controller.ts`).

The browser has the send and fork halves of this window too: `detachable` and `sending` in `src/client/App.svelte` ignore a detach in flight, and `controller.detach`'s `detaching` set guards only `recover` (OW-sugome).
Only the `g` case and the compact case are Emacs-only.
Whether the browser's half is fixed here or in a card of its own is this card's to decide, and the decision goes in the close note.

What is load-bearing: a close in flight is a state the buffer owns, set when the close is sent and read by every command that would reach the session, not a further refusal clause added at each command.
State in the change what becomes of `agentpane-close-session`'s `agentpane--attaching` clause — kept, because an attach sent before the close is a distinct ordering, or subsumed.

Done when ERT tests in `emacs/agentpane-test.el`, built on the `agentpane-test--closing` macro OW-yosege added, hold `sessions/close` (its `hold` list) and show `g`, `C-RET`, `f` and a second `C-c C-q` each sending nothing to the session while it is held, and a close pressed after `agentpane-compact` sent but before any status refused, each red before the change and green after; run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Landed on `main` as 86d5648, 6d85775, 9cc668e and ca23ffb, all Emacs Lisp only, so `bun run check` was not run.

A close in flight is now state the buffer owns: `agentpane--closing` in `emacs/agentpane.el`, set as `sessions/close` goes out and cleared when it answers, success or failure (the failed-close lambda passed to `agentpane--request`, which jsonrpc also runs on "Server died").
It is read at the four chokepoints every request that would reach the session goes through, via `agentpane--refuse-closing`: `agentpane--attach`, `agentpane--attach-now`, `agentpane--attached-then` and `agentpane--fork-point`.
Two per-command reads remain, each for a reason: `agentpane-refetch` answers in the echo area rather than signalling, because the picker refetches a buffer to show it, and `agentpane-close-session` says "already closing" to a second press.
Every other refused command signals `user-error`, calling the caller's FAILED first so `agentpane--sending` and `agentpane--forking` do not stay set.
Requests still sent directly while closing — abort, dismissError, requests/reply — reach routes that never attach.
`agentpane-close-session`'s `agentpane--attaching` clause is kept, not subsumed: an attach sent before the close is an ordering the new state does not cover.

Compaction: `agentpane-compact` writes `:compaction "requesting"` into the buffer's status as the request goes out, mirroring `compact` in `src/client/controller.ts`, and a failed request clears it if it still reads that.
No mark is written while the buffer has no status yet, as `setSessionCompaction` skips it before any snapshot (OW-kimaya); the first cut wrote it anyway and blanked the model, which the adversarial read caught.
Emacs now shares the race the browser accepted in OW-husivu (declined): a status or snapshot carrying no compaction that lands before the server's own "requesting" wipes the mark, so on a just-attached buffer a close can still go out with the compact unanswered; the docstring says so.

Verified by ERT in `emacs/agentpane-test.el`, on `agentpane-test--closing` with `sessions/close` held: `agentpane-test-close-session-in-flight-reaches-nothing` (g, C-RET, f, e and a second C-c C-q each send nothing, then the released close still lands), `agentpane-test-close-session-in-flight-detached-meanwhile-reaches-nothing` (the same after a `session/detached` mid-close, which only the `agentpane--attach` and `agentpane--attach-now` guards catch), `agentpane-test-close-session-that-fails-frees-the-buffer`, `agentpane-test-close-session-refused-once-compaction-requested` and `agentpane-test-compact-before-any-status-marks-nothing`.
The in-flight and compaction tests were run red against main's `agentpane.el` by the dispatching session; the implementer and the adversarial reader each showed the rest red by deleting the guard each covers.
Full suite: 191 tests, 188 as expected, 3 skipped, 0 unexpected.

The browser half went to its own card, OW-ripahi, since it lands in a different client and test suite.
The adversarial read's findings outside this card: OW-wezaji (the helper's sequence-gap re-attach has no close guard), OW-wovamo (close goes ahead with setModel or setEffort in flight), the close-side case of the helper's per-ref `pending` added to OW-jofodu, and the gap between the close answering and its listing added to OW-watawe.
