---
labels: [defect, emacs, emacs-native]
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
