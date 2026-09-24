---
labels: [defect, emacs]
---

# Emacs keeps a turn error drawn after the next prompt is admitted, through the whole turn on Claude Code, where the browser drops it at admission

Found by the adversarial read of OW-desufa on 2026-09-24, and left alone there because it predates that card.

The browser clears a session's turn error once the next prompt is admitted, unless a newer one landed meanwhile: `submit` in `src/client/controller.ts` reads `priorError` before `api.prompt` and calls `clearSessionError` after it only if the error is still that one (OW-31's rule).
The server applies the same rule silently: `SessionManager.submit` in `src/server/http/session-manager.ts` sets `session.error = null` after `adapter.submit` resolves, and broadcasts nothing for it.
Emacs does neither half on its side: `agentpane--send-prompt` in `emacs/agentpane.el`, and the prompt reply that clears `agentpane--sending`, never touch the drawn `(:error MESSAGE)` ewoc nodes, so the line goes only when a later `session/snapshot` redraws without it.

Which snapshot that is depends on the backend, traced by reading the code, not by a live run:
- Claude Code: the prompt route in `src/server/http/app.ts` (the `"prompt"` case, "Read before the attach") attaches before submitting, and the attach broadcasts a snapshot still holding the error; `ClaudeAdapter.submit` in `src/server/adapters/claude/adapter.ts` then applies `reducer.beginTurn` synchronously, whose streaming effect reaches `broadcastSnapshot` in `SessionManager`'s update handler before `submit` clears the error.
  So the error is redrawn below the new user message and the reply streams under it, until the turn-end snapshot.
- Codex and Pi broadcast a snapshot at turn start and turn end; the turn-end one clears the line for certain, and whether the turn-start one does depends on whether admission resolves before it, which the reader could not confirm.

In service of `AGENTS.md`, "Both clients": the browser's banner goes at admission and Emacs's line should too.
Load-bearing: Emacs clears only the error it had drawn when the prompt was sent, the way `controller.ts` compares `priorError`, so a turn error that arrives while the prompt is in flight survives admission.
Incidental: whether the clear hangs off the prompt's reply callback or elsewhere in the send path.

Done when an ERT test in `emacs/agentpane-test.el` drives a buffer that has an error drawn, sends a prompt through the recorded-request harness used by `agentpane-test-dismiss-error-names-it-to-the-server`, answers the prompt, and finds no `⚠` line drawn — red first — and a second case in which a newer `session/error` arrives before the answer keeps that newer line; the full ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, passes, and that Commentary's sentence "A turn error stays drawn until a snapshot arrives without it" is reworded to match.
