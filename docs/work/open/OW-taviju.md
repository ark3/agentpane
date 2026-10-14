---
labels: [defect, emacs]
blocked-by: [OW-dulipe]
---

# agentpane-mode keeps its submit watch after a Pi prompt an extension command handled, so the next turn on that session reads as this buffer's

Filed 2026-10-14 from OW-kokotu; read at the code, not run in Emacs.
See `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", paragraph "What each client shows, read at the code and not run".

`agentpane--send-prompt` in `emacs/agentpane.el` arms `agentpane--watch-submit` as the prompt goes out and drops it only for a prompt the server refused or that never went out.
A Pi prompt such as `/mcp` that an extension command consumes is admitted and starts no turn (OW-dulipe), so the watch stands until the next turn that streams on that session, whoever started it.
Nothing in the buffer says the prompt was consumed by a command.
agentpane-mode also carries no counterpart of the browser's leading-`/` composer warning from OW-73; that gap is the separate card on that warning, not this one.

Once OW-dulipe puts the handled outcome on the helper's `sessions/prompt` answer, agentpane-mode should drop the watch for it and tell the user no turn followed, matching the browser's card blocked by the same wire card.

## Done when

An ERT test in `emacs/agentpane-test.el`, red first, answers `sessions/prompt` as handled and asserts the submit watch is dropped and the buffer shows that no turn started; it passes under `emacs --batch -L emacs -l ert -l agentpane -l emacs/agentpane-test.el -f ert-run-tests-batch-and-exit`, which `bun run check` does not run.
