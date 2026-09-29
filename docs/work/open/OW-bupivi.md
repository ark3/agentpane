---
labels: [change, emacs]
---

# agentpane-mode has no command that only attaches a previewed session, as the browser's Attach button does

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

While a session is previewed, the browser swaps the composer for an Attach button (`attachSelected` in `src/client/App.svelte`), which opens the live session and focuses the prompt without sending anything.
In `emacs/agentpane.el` a preview attaches only as a side effect of something else.
A send and `agentpane-compact` attach through `agentpane--attached-then`, `agentpane-fork` through `agentpane--attach`, and interactive `agentpane-set-model` and `agentpane-set-effort` through `agentpane--attach-now`.
The `agentpane-fork` docstring states the gap: "there is no command that only attaches".

The wire is enough: `sessions/attach` exists.
The browser's behaviour is pinned by `src/client/App.test.ts` "swaps the composer for an Attach button while previewing, opens the live session, and focuses the prompt".

Done when an ERT test in `emacs/agentpane-test.el` runs the new command on a preview buffer and sees `sessions/attach` sent and the buffer attached, red before the change and green after.
The `agentpane-fork` docstring's sentence is retired in the same change.

## Amended 2026-09-29 under D26

OW-zavehi's decision, D26 in `docs/DESIGN.md`, point 7, makes this command required rather than optional: once `agentpane--dropped` goes, `g` in a buffer that is not attached previews, and this command is how such a buffer goes live without sending anything.
OW-vugefa is blocked by this card for that reason.
