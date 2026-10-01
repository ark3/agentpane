---
labels: [defect, emacs]
closed: declined
---

# A Pi fork still badges for a parent turn this client sent when the turn ends by a path other than the fork's own abort, in both clients

Filed 2026-09-30 from the adversarial read of OW-rihanu; read at the code, nothing run.
In service of the rule OW-dunahe set for agentpane-mode and OW-rihanu gave the browser: a parent turn a Pi fork stops was stopped on purpose, so its end raises no turn-done indicator; the parity rule is `AGENTS.md`, "Both clients".

OW-rihanu drops the parent's watch at one point only: `forkAndSubmit` in `src/client/controller.ts` calls its `onAbort` callback just before `await api.abort(selected)`, inside the branch that fires only when the parent is Pi and reads `isStreaming`, and `send()` in `src/client/App.svelte` answers with `watchAbandon` from `src/client/favicon.ts`.
agentpane-mode does the same in `agentpane--fork-points` in `emacs/agentpane.el`, calling `agentpane--watch-forget` just before `sessions/abort`.
Two paths reach the same stopped turn without passing through that point.

Case A, a fork pressed before `status:true` arrives (inferred, not run).
Right after a submit the session reads `isStreaming:false` for a beat (the `watchSessions` docblock in `src/client/favicon.ts`, "Done is a *transition*"), so neither client sends the abort and neither drops the watch.
`status:true` can then land during the fork-points and fork round trip, and Pi's CLI stops the turn at the fork anyway: as of `pi 0.87.1` the abandoned turn's last events, `agent_settled` among them, arrive before the `fork` response (`AGENTS.md`, "Evidence", OW-dutute), so its `status:false` badges an unfocused client.
The Emacs pin `agentpane-test--pi-fork-during-a-turn` in `emacs/agentpane-test.el` has an `'unstreamed` case, but it emits those statuses only after the fork's reply, so it never exercises this order.

Case B, Stop and edit.
`editLastMessage()` in `src/client/App.svelte` stops a streaming Pi turn at the click with `if (stopsBeforeFork) void controller.abort();`, which has no `onAbort`, and agentpane-mode's edit-last command calls `agentpane-abort`, which forgets no watch.
If that abort's `status:false` lands while the client is unfocused, it badges; by the time the fork is sent the parent reads not streaming, so the fork's own drop never fires.
The code calls this the fork's stop too (the `editLastMessage` docblock, "stops it at the click rather than at submit", and the `abort` bullet in `src/server/http/session-manager.ts` naming the `forkAndSubmit` abort "the second abort"), but the user may cancel the edit and be left with a plain Stop, which badges on purpose (the `watchSessions` docblock's "First cut, 2026-08-18" paragraph).
Whether Case B raises is the executor's call; record the choice and its reason in that "First cut" paragraph and in agentpane-mode's counterpart docstring, so both clients state the same rule.

Load-bearing: in each client, a Pi fork that reaches the fork request leaves no watch on the parent's handle, whichever order the parent's `status:true`, its `status:false` and the fork's reply arrive in; a fork that bails before both the abort and the fork request leaves the watch standing, because the turn it watches was never stopped; Codex and Claude Code parents, whose turns survive the fork (D15), keep their watches.
Placement is the executor's; the adversarial reader suggested dropping just before `api.fork` on Pi as well as at the abort, never before `api.forkPoints`, whose failure would otherwise silence a turn still running.
If the placement chosen subsumes OW-rihanu's `onAbort`, the done-condition includes that callback being gone, not only the new cases passing.

Done when, red first, a test in `src/client/App.test.ts` driving the real controller (`createController`, as OW-rihanu's "badges the %s parent turn this tab sent, forked mid-turn, only where the fork leaves it running" does) submits on a Pi session, forks before `status:true` arrives, emits `status:true` then `status:false` for the parent before resolving the fork, and asserts no badge at the parent's end and a badge at the fork's; an ERT test in `emacs/agentpane-test.el` pins the same order for agentpane-mode; Case B's decision is recorded as above, with a test in each client pinning whichever way it went; and `bun run check` passes, and the Emacs suite passes, run by the `ert-run-tests-batch-and-exit` command in `emacs/agentpane-test.el`'s header.

## Close note

Declined 2026-09-30 by the owner, read at the code and not run.
Both cases end in a badge only if the client is unfocused (the browser's `hasFocus` read in `watchSessions`) or the parent's buffer is not shown (agentpane-mode) at the moment the stopped turn's `status:false` arrives, and in both that status follows within one round trip of a click the user just made in that tab or buffer: the fork press in case A, Stop and edit in case B.
In agentpane-mode the fork's buffer takes the parent's window only at the fork's reply (`agentpane-fork` in `emacs/agentpane.el`), and as of `pi 0.87.1` the abandoned turn's last events arrive before that reply (OW-dutute), so the parent's buffer is still shown when its status lands.
So each case needs the user to leave the client within a fraction of a second, and costs one spurious badge; the owner has declined state for cases of that size twice on 2026-09-30 (a deliberate shutdown under OW-nuzoto, a gap under OW-bepudu and OW-jadoda).
If a spurious badge after a Pi fork is ever seen in use, this card's two paths and the reader's suggested placement (drop the parent's watch just before `api.fork` on Pi as well as at the abort, never before `api.forkPoints`) are where to start.
