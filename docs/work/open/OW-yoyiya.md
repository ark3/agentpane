---
labels: [defect, emacs, emacs-native]
---

# A second C-RET while agentpane-mode is still attaching sends the prompt twice, and a preview reply can land over the live transcript

Found 2026-09-22 by the adversarial read of OW-gunuke's change, reproduced with a stubbed connection in `emacs --batch` (Emacs 31.1, jsonrpc.el 1.0.29); not seen live, since that session could not start Codex.

## Double send

In `emacs/agentpane.el`, `agentpane-send` and `agentpane-composer-send` go through `agentpane--send-prompt`, which calls `agentpane--attached-then`.
While the first attach is in flight `agentpane--attached-p` is still nil, so a second `C-RET` sends a second `sessions/attach`, and both attach callbacks run — `agentpane--attach` passes `always` to `agentpane--request` — each sending `sessions/prompt` with the same text.
The probe's outgoing requests read: attach, attach, prompt "hello", prompt "hello".
Nothing marks a send as pending and the draft stays visible until the prompt's reply (`agentpane--clear-sent`), so pressing again while a backend spawns is the natural move.
Claude Code and Pi reject the second prompt mid-turn with an echo-area error; Codex steers the running turn with it (DESIGN D16, and the comment beside `turn/steer` in `src/server/adapters/codex/adapter.ts`), so the user message goes in twice — read from that code, not run.
The same double send is reachable on an attached buffer by two `C-RET`s before the first prompt's reply, if the backend takes the second as a steer.

## Preview over live

`g` (`agentpane-refetch`) or `RET` on the same row in the picker (`agentpane-show-transcript`) during a first-prompt attach sends `sessions/preview` without `always`, making it the buffer's latest request.
If its reply lands after the attach's `session/snapshot` but before the attach reply, the stored transcript is drawn over the live one until the next snapshot.
Reasoned from the code, not probed in that order.

## Timeout

The asynchronous attach and prompt use jsonrpc.el's default 10s timeout, while `agentpane-new-session`'s synchronous attach allows 60s.
A first-prompt attach that runs past 10s reports "sessions/attach timed out", never sends the prompt, and discards the late reply, so `agentpane--attached` stays nil though the helper did attach.
Whether a spawn ever takes 10s is unmeasured; `docs/MANUAL_TESTING.md` has a 1.138s re-attach.

## Done when

An ert test in `emacs/agentpane-test.el`, in the style of `agentpane-test-set-model-only-before-the-first-prompt` (stubbing `agentpane--request` with `cl-letf`, no process), sends twice from a buffer whose attach has not answered and asserts one `sessions/prompt` goes out; it fails before the fix.
A second one asserts a preview reply arriving after an attach was sent does not redraw the buffer.
Choose the timeout deliberately and say why in the docstring; the two figures above are the only evidence there is.
