---
labels: [change, emacs]
---

# agentpane-mode's n and p step through every node, with no key that steps between user messages as the browser's rail does

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's rail steps to the previous or next user message, and jumps to the transcript's start or end: `navigate` and `navTargets` in `src/client/App.svelte`.
`agentpane-next` and `agentpane-prev` (`n`, `p`) in `emacs/agentpane.el` step through every node, assistant and tool nodes included.
The start and end are Emacs's own buffer keys, so only the user-message step is missing.

No wire is needed.
The browser's behaviour is pinned by `src/client/App.test.ts` "steps the rail between user turns".

Done when an ERT test in `emacs/agentpane-test.el` draws a transcript interleaving user, assistant and tool nodes and sees the new command land only on user nodes in both directions, red before the change and green after.
