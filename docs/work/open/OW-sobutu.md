---
labels: [change]
---

# The browser can fork only by sending an edited message, where agentpane-mode's f forks at a message and opens the fork with nothing sent

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`agentpane-fork` (`f`) in `emacs/agentpane.el` forks at the user message at point and opens the fork attached, with no prompt sent (closed OW-fojike).
In the browser a fork happens only inside edit-and-send: `forkAndSubmit` in `src/client/controller.ts`, reached from `send` in `src/client/App.svelte` while `editing` is set.
`docs/DESIGN.md` D17 describes that gesture ("Pressing send in edit mode forks the session and prompts the fork") and settles only what a click elsewhere does during it, so nothing decided the browser should lack a plain fork.

The wire is enough: `api.fork` in `src/client/api.ts` and its HTTP route already exist, and `forkAndSubmit` calls the first before it prompts.
The Emacs behaviour is pinned by ERT `agentpane-test-fork-at-a-fork-point`, `agentpane-test-fork-on-a-preview-attaches-first` and `agentpane-test-fork-aborts-a-streaming-pi-turn` in `emacs/agentpane-test.el`.
Where the control sits is this card's to choose; D20 already limits it to messages a fork point names.

Done when a test in `src/client/App.test.ts` or `src/client/controller.test.ts` sees the fork created and selected with no prompt sent, red before the change and green after.
