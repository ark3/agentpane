---
labels: [defect]
---

# The browser badges for a parent turn this tab submitted when Pi's Stop and fork aborts it, where agentpane-mode drops that watch at the abort and raises nothing

Found 2026-09-30 by the implementer of OW-koledi, read at the code and not run; the parity rule is `AGENTS.md`, "Both clients".

OW-dunahe decided the Emacs side: `agentpane--fork-points` in `emacs/agentpane.el` forgets the parent's turn-done watch as it sends the abort, because the aborted turn's end "raised the indicator for a turn the user had stopped on purpose" (the `agentpane-mode` docstring holding "A Pi fork stops it, the loss deliberate", and OW-dunahe's close note, "Pi fork").
The browser does not: when this tab submitted the parent's running turn, its watch sits in `TurnWatch.waiting` (`src/client/favicon.ts`) under the parent's handle, and `forkAndSubmit` in `src/client/controller.ts` aborts that turn on Pi ("if (selected.backend === \"pi\" && handle !== undefined && view.state.sessions[handle]?.isStreaming) await api.abort(selected);"), whose `status:false` makes `watchSessions` badge an unfocused tab.
Since OW-koledi, `send()` in `src/client/App.svelte` arms the fork's watch on the fork's own handle and leaves the parent's alone, so the parent's own watch runs to the abort's end; before it, `send()` re-armed the parent with `watchSubmit` and moved that watch onto the fork, and whether that ever kept this badge down is unverified.

Load-bearing: in the browser, a Pi fork's abort ends any watch on the parent's handle without badging, whichever order the abort's status and the fork's reply arrive in, and a watch on a Codex or Claude Code parent, whose turn survives the fork (D15), is left to badge when that turn ends.
Where the drop happens -- `send()` before `forkAndSubmit`, or the controller telling `App.svelte` at the abort -- is the executor's call.

Done when a test in `src/client/App.test.ts`, red first, drives the real controller (`createController`, as OW-koledi's "badges the fork's turn and not the streaming %s parent's that ends mid-fork" does) through a submit on a Pi session, its turn streaming, an edit-and-resend of an earlier message that aborts it, with the window unfocused, and asserts no badge at the parent's turn's end and a badge at the fork's; a Codex case of the same shape still badges at the parent's end; and `bun run check` passes.
