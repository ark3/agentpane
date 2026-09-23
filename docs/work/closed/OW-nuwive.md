---
labels: [defect, emacs, emacs-native]
closed: done
---

# agentpane-mode loses track of an attach when its transcript buffer is killed and reopened, when an attach fails, or when the attach reply renames the session without a session/renamed

Found 2026-09-22 while landing OW-gunuke, by its implementer and by the adversarial read of its change; each item reasoned from the code in `emacs/agentpane.el` and `src/emacs/helper.ts`, none probed live.

- **Killed and reopened.** The helper keeps a session in its `attached` set until `sessions/close` (`src/emacs/helper.ts`, the `"sessions/close"` handler), and killing the transcript buffer sends nothing.
  Reopen it from the picker and a `session/node` arriving before the preview's reply finds `agentpane--ewoc` nil in `agentpane--upsert` and errors inside a jsonrpc timer.
  Once drawn, `agentpane--attached` is nil in the new buffer, so `g` (`agentpane-refetch`) previews over a session that is live.
- **Attach failure in `agentpane-new-session`.** The buffer is made and drawn empty before the synchronous `sessions/attach`; if that errors or is quit with `C-g`, the buffer stays, unattached and never displayed, holding the new session.
  Emacs is blocked for up to that request's 60s timeout meanwhile.
- **Attach reply names another ref with no `session/renamed`.** `agentpane--on-notification` finds the buffer by the ref it holds; a `session/snapshot` for the new ref that arrives before the attach reply rekeys the buffer (`agentpane--rekey`) is dropped, and the buffer stays stale until `g`.
  When the server does broadcast `renamed` — all three backends did as of 10a4b63 — the helper forwards it and this does not arise, so the question is whether the attach route can change a ref without one.

## Done when

For each item, either an ert test in `emacs/agentpane-test.el` that drives the case through `agentpane--on-notification` or stubbed requests with no process, failing before the fix, or a sentence recorded in this card saying why the case cannot arise, citing the code that rules it out.

## Close note

Landed on main as 62901c4..b3d71e6, plus a docstring rewrap.
All three items were fixed with tests; none was recorded as unable to arise.

- **Killed and reopened.** A new helper verb `sessions/detach` (`src/emacs/helper.ts`, documented in `src/emacs/protocol.ts`) drops a session from the helper's attached set and makes no HTTP call.
  `sessions/close` was rejected because `SessionManager.close` lets go of the agent, and killing a buffer should leave the session running, as closing a browser tab does.
  `agentpane--detach`, a buffer-local `kill-buffer-hook` on every transcript buffer, sends it whenever a helper is running (never starting one), whatever the buffer believes about its own attach, since an attach that timed out or was quit in Emacs may still have succeeded in the helper; an error sending it is reported and never stops the kill.
  A Pi fork now detaches its parent from the helper too, since the server leaves that parent detached.
- **Attach failure in `agentpane-new-session`.** The buffer is shown before the synchronous attach, so a failed or quit attach leaves the new session in view, where a send attaches it again.
  The up-to-60s block of that synchronous attach is unchanged.
- **Attach reply renaming with no `session/renamed`.** This can arise: an attach through an alias an earlier rename left (`SessionManager.attach` resolves it through `#aliases` and broadcasts only a snapshot under the new ref), a first start whose `renamed` (`#adoptRef` in `#start`) goes out before the helper's stream is registered, and `#start` mapping a spelling to another ref through the index.
  The helper filtered by the asked-for key and so dropped the new ref's snapshot; its `sessions/attach` handler now, when the reply's ref differs and the asked-for key is still attached, moves the key and sends `session/renamed` and the snapshot its reducer holds, before the reply.

Verified: ert 29/29 on Emacs 31.1 and `bun run check` 1170/1170; each new test (`agentpane-test-kill-detaches-the-session`, `agentpane-test-kill-completes-when-the-detach-signals`, `agentpane-test-pi-fork-detaches-the-parent`, `agentpane-test-new-session-shown-when-its-attach-fails`, and the helper tests "says nothing more after sessions/detach…" and "says the rename an attach reply reveals…") was shown red first.
The server orderings were read from the code by an adversarial reader, not run live.

Filed from the review: OW-jafini, for two buffers holding one ref after a rekey.
