---
labels: [defect, emacs]
closed: moot
---

# agentpane-close-session goes ahead with a sessions/setModel or sessions/setEffort in flight, whose attach-first route can respawn the session the close is disposing of

Found by the adversarial read of OW-dakeyi on 2026-09-28, read and not run; it predates that card.
In service of a close reaching nothing it did not mean to, the same concern OW-dakeyi settled for requests sent after the close.

`agentpane-close-session` in `emacs/agentpane.el` refuses with a prompt, a fork or an attach in flight (`agentpane--sending`, `agentpane--forking`, `agentpane--attaching`), but `agentpane-set-model` and `agentpane-set-effort` set no local state when they send.
Both routes attach first (`sessions/setModel` and `sessions/setEffort` in `src/server/http/app.ts`), and the helper answers requests concurrently, so if the close's `DELETE` reaches the server first, the setModel attach waits out the disposal (`SessionManager.attach`'s `#disposing` wait in `src/server/http/session-manager.ts`) and spawns the session again, which no buffer then holds.
The easiest way in is `agentpane-new-session`, which sends setModel and then setEffort from its replies, followed at once by `C-c C-q`.
The browser's `detachable` in `src/client/App.svelte` reads `view.sending` and not a model or effort change in flight either; whether the browser has the same gap is part of this card to establish, and whatever the answer, it goes in the close note, with the browser's fix a card of its own per "Both clients" in `AGENTS.md` if it has one.

Done when an ERT test in `emacs/agentpane-test.el`, built on the `agentpane-test--closing` macro, holds `sessions/setModel` (its `hold` list), presses `C-c C-q`, and asserts `sessions/close` is not sent, red before the change and green after, and the same for `sessions/setEffort`; run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Moot under D25 (2026-09-28): its whole premise is that `sessions/setModel` and `sessions/setEffort` attach first and so respawn the session a close is disposing of.
OW-sirofi makes the attach route the only one that spawns and carries the server-side test of a setModel sent while a close is out; with it, the request is refused and nothing respawns, in both clients, so neither needs a guard for this.
