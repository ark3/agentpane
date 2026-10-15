---
labels: [change, emacs]
closed: moot
---

# agentpane-mode does not warn that a prompt opening with / is sent as text, not run as a slash command (OW-73)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser shows a warning line under the composer while the draft starts with `/`, because agentpane sends it to the agent as text and no backend runs it as a command: `looksLikeSlashCommand` in `src/client/App.svelte` (closed OW-73).
`agentpane-mode`'s composer in `emacs/agentpane.el` shows nothing.

No wire is needed.
The browser's behaviour is pinned by the three OW-73 tests in `src/client/App.test.ts`.

Done when ERT tests in `emacs/agentpane-test.el` mirroring those three go red before the change and green after.

## Close note

Duplicate of OW-sidese, filed 2026-10-14 from OW-kokotu's live run on `pi 1.2.0`, which asks for the same agentpane-mode warning for a draft opening with `/` and also corrects the warning's wording, since a Pi extension command such as `/mcp` is run by Pi rather than sent as text.
Closed by the owner's choice on 2026-10-14; the work lives in OW-sidese.
