---
labels: [defect, emacs]
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
