---
labels: [defect, emacs]
blocked-by: [OW-dulipe]
closed: done
---

# agentpane-mode keeps its submit watch after a Pi prompt an extension command handled, so the next turn on that session reads as this buffer's

Filed 2026-10-14 from OW-kokotu; read at the code, not run in Emacs.
See `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", paragraph "What each client shows, read at the code and not run".

`agentpane--send-prompt` in `emacs/agentpane.el` arms `agentpane--watch-submit` as the prompt goes out and drops it only for a prompt the server refused or that never went out.
A Pi prompt such as `/mcp` that an extension command consumes is admitted and starts no turn (OW-dulipe), so the watch stands until the next turn that streams on that session, whoever started it.
Nothing in the buffer says the prompt was consumed by a command.
agentpane-mode also carries no counterpart of the browser's leading-`/` composer warning from OW-73; that gap is the separate card on that warning, not this one.

Once OW-dulipe puts the handled outcome on the helper's `sessions/prompt` answer, agentpane-mode should drop the watch for it and tell the user no turn followed, matching the browser's card blocked by the same wire card.
OW-dulipe's shape: `sessions/prompt` answers `{ "disposition": "handled" }` for a handled prompt and `null` for a started one (`HelperRequests` in `src/emacs/protocol.ts`).
"Handled" means no turn was started for this prompt, not that nothing follows it on the stream.
Pi's installed `docs/rpc-commands.md`, "prompt", on `pi 1.2.0`, says the disposition "describes the submitted prompt, not independent work started by an extension", and Pi's own `examples/extensions/send-user-message.ts` registers `/ask`, which answers `handled` and then streams a whole turn through `pi.sendUserMessage` (read at the source, not run).
So the message to the user must not promise that nothing is coming, and a turn an extension starts this way is arguably the one the user asked for; decide what the arm does for it and say so in the test.

## Done when

An ERT test in `emacs/agentpane-test.el`, red first, answers `sessions/prompt` as handled and asserts the submit watch is dropped and the buffer shows that no turn started; it passes under `emacs --batch -L emacs -l ert -l agentpane -l emacs/agentpane-test.el -f ert-run-tests-batch-and-exit`, which `bun run check` does not run.

## Close note

Landed in 53914be and fed962b (emacs/ only; `bun run check` not needed, nothing under `src/` changed).
`agentpane--send-prompt` now reads the `sessions/prompt` answer: on `(:disposition "handled")` it abandons the turn-done watch its prompt armed, by identity as a refusal does (a prompt that joined a running turn's watch armed nil and drops nothing), still clears the draft, and sets the buffer-local `agentpane--handled`, drawn by `agentpane--show-reading-tail` on the tail overlay's `before-string` below any tail line as "The agent handled that prompt itself; no turn was started for it." (the browser's OW-yobayi wording) until the next send, from the prompt region, the composer or an edit; through an edit the line shows in the fork's buffer.
Decision, matching OW-yobayi: a turn the handling extension starts of its own (Pi's `/ask`) is not watched either, since nothing on the stream tells it from another client's turn; the docblock and test say it holds only when the answer precedes the turn's events.
Verified by three new ERT tests in `emacs/agentpane-test.el` (handled prompt drops the watch and shows the line; a handled prompt mid-turn keeps the running turn's watch; an edit's handled prompt says so in the fork and clears the parent's line), shown red against the parent commit's `agentpane.el`, plus a mutation-checked assertion that the handled line follows the reading tail; the full suite ran 255, 0 unexpected, 3 unrelated skips, on main.
The adversarial read confirmed by running that the reply-site abandon misses a merge that kills the sender before the reply and a turn that ends before the reply, and by reading a reply past `agentpane--spawn-timeout`; those went to OW-kejire, which replaces the check.
Not run in Emacs against a live Pi.
