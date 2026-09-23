---
labels: [change, emacs-native]
---

# agentpane-mode draws tool calls and thinking as bare fold lines; agent-shell's renderer is the model to borrow from

Owner, 2026-09-23, on the work laptop against Claude Code: outside reading view, tool calls and thinking look much nicer in the web UI than in Emacs, but Emacs could look better still without the web UI's box model, and "agent-shell has a great renderer".
The owner ranks this below reading view (OW-motuso) and the meta line (OW-janimi).

## Where things stand

D22 in `docs/DESIGN.md` and OW-vibipo's "Rendering verdict, 2026-09-22" settled the prose, drawn through `shr`; what the owner disliked in `agent-shell` was its prose rendering, and neither record judged its tool calls.
OW-dekate's rounds judged the prose and left the tool and thinking drawing at its first round, which OW-wavone's "Drawing" list carried over: `agentpane--insert-tool` draws the tool name, its `summary` and a state marker on one fold line, with `args`, `result` and diff lines behind it (`agentpane--tool-body`, `agentpane--diff-text`), and `agentpane--insert-thinking` draws `thinking: ` plus the first line in italics, the rest folded; both in `emacs/agentpane.el`, both built on `agentpane--insert-fold`.
The data is the `tool` and `thinking` parts in the "Parts" list of `src/emacs/protocol.ts`; a new look may want a field the node does not carry, and adding one goes through `src/emacs/nodes.ts` and the contract with a test there.

## The reference

`agent-shell` 7377ba8 (2026-09-11) is installed under the home server's `~/.emacs.d/straight/repos/agent-shell/`, the version OW-vibipo read.
Its tool-call and thinking fragments are drawn in `agent-shell-ui.el` and driven from the `tool_call` and `tool_call_update` handling in `agent-shell.el`, with faces in `agent-shell-faces.el` and `agent-shell-styles.el`.
Read it for what makes it look good -- header layout, status glyphs, how the body is framed and indented, how a diff and a long result are shown, how thinking is set apart -- and borrow the look, not the code or its fragment model.

## How it closes

This is a look judged by eye over rounds, the owner's practice for a UI decision and the one OW-dekate followed: a first cut drawn from stored sessions with Edit diffs, shell commands and thinking, looked at by the owner in a live Emacs beside the browser and `agent-shell`, then revised.
Done when the owner has said the look is settled, the rounds and the verdict are recorded in this card's close note, and `emacs/agentpane-test.el` asserts the structure the final drawing commits to -- fold toggling, diff lines in `diff-mode` faces, a signature-only thinking part drawing nothing -- green as that file's Commentary says, with any test the change breaks updated rather than deleted.
