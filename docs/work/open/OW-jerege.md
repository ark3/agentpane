---
labels: [change, emacs]
blocked-by: [OW-kihisa]
---

# agentpane-mode has no Edit last message, nor the Stop and edit that takes a streaming Pi turn's last message back into the composer (OW-relehi)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's composer offers "Edit last message", which takes the last user message back into the composer as OW-kihisa's edit does, and on a streaming Pi turn offers "Stop and edit", which aborts the turn at the click first.
It is `lastUserIndex`, `editLastMessage` and `stopsBeforeFork` in `src/client/App.svelte`; closed OW-relehi is where it was built.
In `emacs/agentpane.el` a user moves point to the message and presses `f`, and `agentpane-fork` aborts a streaming Pi turn only at that press (ERT `agentpane-test-fork-aborts-a-streaming-pi-turn`).

This is blocked by OW-kihisa because it reuses that card's edit gesture; it adds only the shortcut to the last message and the abort before it.
The browser's behaviour is pinned by `src/client/App.test.ts` "stops the running turn and takes the last message back into the composer (OW-relehi)", "edits the last message into exactly the state" and "withdraws Edit last message when the last message is not a fork point".

Emacs has no standing control to withdraw, so the third mirrors as a refusal at the press when the last message is not a fork point.

Done when ERT tests in `emacs/agentpane-test.el` mirroring those three go red before the change and green after.
