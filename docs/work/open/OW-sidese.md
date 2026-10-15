---
labels: [defect, emacs]
---

# OW-73's composer warning says a leading / reaches the agent as plain text, which a Pi extension command disproves, and agentpane-mode has no such warning

Filed 2026-10-14 from OW-kokotu's live run on the home server, `pi 1.2.0`; see `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", subsection "A prompt an extension command handles".

OW-73 (closed) added a warning by the browser's composer for any draft starting with `/`: `Agentpane does not run slash commands — this will be sent to the agent as plain text.`, the `looksLikeSlashCommand` block in `src/client/App.svelte`.
On Pi 1.2.0 that is false for an extension command: `/mcp`, `/llama` and `/refs` on the home server are run by Pi itself and never reach the model (`disposition: "handled"`).
Codex and Claude Code still take such text as a prompt, as far as anything here measured.
agentpane-mode in `emacs/agentpane.el` carries no counterpart of the warning at all, a parity gap with the browser that predates the owner's 2026-09-23 parity rule (AGENTS.md "Both clients").
That gap was OW-yedipi's, closed `--moot` into this card on 2026-10-14.

OW-73's owner decisions stand and bind this card: warn, never block; a bare leading-`/` check with no command list; rendered next to the text being typed.
Only the claim the copy makes is wrong; the new wording is the executor's first cut, and must not promise either outcome on a backend where both happen.

## Done when

- The browser test in `src/client/App.test.ts` that asserts the `/compact` warning is shown also asserts the warning no longer claims the text will be sent to the agent as plain text, red first.
- An ERT test in `emacs/agentpane-test.el`, red first, asserts agentpane-mode shows the same warning for a draft starting with `/` and none for an ordinary one, without blocking the send; it passes under `emacs --batch -L emacs -l ert -l agentpane -l emacs/agentpane-test.el -f ert-run-tests-batch-and-exit`.
- `bun run check` passes.
