---
labels: [defect]
closed: done
---

# The browser badges for a parent turn this tab submitted when Pi's Stop and fork aborts it, where agentpane-mode drops that watch at the abort and raises nothing

Found 2026-09-30 by the implementer of OW-koledi, read at the code and not run; the parity rule is `AGENTS.md`, "Both clients".

OW-dunahe decided the Emacs side: `agentpane--fork-points` in `emacs/agentpane.el` forgets the parent's turn-done watch as it sends the abort, because the aborted turn's end "raised the indicator for a turn the user had stopped on purpose" (the `agentpane-mode` docstring holding "A Pi fork stops it, the loss deliberate", and OW-dunahe's close note, "Pi fork").
The browser does not: when this tab submitted the parent's running turn, its watch sits in `TurnWatch.waiting` (`src/client/favicon.ts`) under the parent's handle, and `forkAndSubmit` in `src/client/controller.ts` aborts that turn on Pi ("if (selected.backend === \"pi\" && handle !== undefined && view.state.sessions[handle]?.isStreaming) await api.abort(selected);"), whose `status:false` makes `watchSessions` badge an unfocused tab.
Since OW-koledi, `send()` in `src/client/App.svelte` arms the fork's watch on the fork's own handle and leaves the parent's alone, so the parent's own watch runs to the abort's end; before it, `send()` re-armed the parent with `watchSubmit` and moved that watch onto the fork, and whether that ever kept this badge down is unverified.

Load-bearing: in the browser, a Pi fork's abort ends any watch on the parent's handle without badging, whichever order the abort's status and the fork's reply arrive in, and a watch on a Codex or Claude Code parent, whose turn survives the fork (D15), is left to badge when that turn ends.
Where the drop happens -- `send()` before `forkAndSubmit`, or the controller telling `App.svelte` at the abort -- is the executor's call.

Done when a test in `src/client/App.test.ts`, red first, drives the real controller (`createController`, as OW-koledi's "badges the fork's turn and not the streaming %s parent's that ends mid-fork" does) through a submit on a Pi session, its turn streaming, an edit-and-resend of an earlier message that aborts it, with the window unfocused, and asserts no badge at the parent's turn's end and a badge at the fork's; a Codex case of the same shape still badges at the parent's end; and `bun run check` passes.

## Close note

Landed as 6b9b70a on main, "client: raise nothing for a parent turn this tab sent when a Pi fork stops it (OW-rihanu)".
`forkAndSubmit` in `src/client/controller.ts` takes a fourth optional callback, `onAbort(handle)`, called with the parent's handle synchronously just before `await api.abort(selected)` and only inside the Pi-and-streaming branch; `send()` in `src/client/App.svelte` answers it with `watchAbandon`.
The controller says when rather than `send()` deciding, because it alone decides whether the abort goes out: a fork that bails first (not live, already sending, no draft) or a parent already idle leaves a turn that was never stopped, and its badge stands.
Because the drop precedes the abort request, no event the abort causes can reach `watchSessions` first, so the order of the abort's `status:false` and the fork's reply cannot matter.
This matches agentpane-mode's `agentpane--watch-forget` in `agentpane--fork-points` (OW-dunahe), including that a failed abort leaves the turn running unwatched, which the `onAbort` docblock now says.

Verified: the new `it.each(["pi", "codex"])` test in `src/client/App.test.ts`, "badges the %s parent turn this tab sent, forked mid-turn, only where the fork leaves it running (OW-rihanu)", drives the real controller unfocused through a plain submit, the parent streaming, and an edit-and-resend, with the parent's `status:false` landing while the abort's POST is still out.
Against the pre-fix controller and App, re-run by the dispatching session, the Pi case failed with "expected '/favicon-badged.svg' to be '/favicon.svg'" and the Codex case passed; with the fix both pass, and `bun run check` passed (0 svelte-check errors, 1591 tests).
The adversarial reader confirmed the key `onAbort` passes is the one `armBadge` armed, and that a wrong key, a call after the abort, or a call on Codex would each turn the test red.

Review amended two docblocks: the `watchSessions` "First cut" paragraph in `src/client/favicon.ts` had claimed every Pi fork's abort raises nothing, when Stop and edit's does; and the `onAbort` docblock now states the failed-abort case.
The reader found two paths that still badge a turn a Pi fork stopped, in both clients: a fork pressed before `status:true` arrives, and Stop and edit's abort at the click; filed as OW-piwavo.
