---
labels: [defect]
---

# The browser's badge watch sits on the parent's handle for the whole of a fork's prompt, so a gap on the fork's handle in that window ends nothing and watchMove then carries the watch onto a handle whose view the gap dropped

Filed 2026-09-30 from the adversarial read of OW-jadoda (commit "a seq gap ends the favicon's turn watch on its handle, streamed or not (OW-jadoda)"); traced at the code, not run.
In service of D25 point 5 in `docs/DESIGN.md`, where the owner decided on 2026-09-30 that a gap raises nothing and drops the turn-done watch on that handle, `streamed` or not, in both clients.

## What OW-jadoda built, and where it stops

`detachGapped` in `src/client/controller.ts` tells `subscribeGaps` listeners the handle it drops, and `App.svelte` answers with `watchAbandon(turnWatch, handle)`.
That ends only a watch already sitting on the gapped handle at the instant of the gap: nothing remembers that a handle gapped, so a watch that arrives on it afterwards is not caught.

## The case it misses

`send` in `src/client/App.svelte` arms the watch on the parent's key (`armBadge`, then "const armedKey = view.state.selected") and keeps it there until `controller.forkAndSubmit` resolves; only then does `rekeySession(armedKey, landed.handle)` run `watchMove` onto the fork.
Inside `forkAndSubmit` the fork's view forms from the attach's snapshot before `api.prompt` is sent, and the fork's turn streams under its own handle while that POST is out.
A gap on the fork's handle in that window calls `watchAbandon` on the fork's handle, which holds nothing, and the view goes; `watchMove` then puts the watch onto the fork's handle, `watchSessions` reads the missing view as "not formed yet" and keeps waiting, and a later snapshot under that handle (the fork preview's Attach, or another client's attach) re-forms it and its turn's end badges: OW-jadoda's bug again.
The comment beside `if (isStreaming === undefined) continue;` in `watchSessions` (`src/client/favicon.ts`) names this card as the exception.

## Two more ways the same parent-keyed watch goes wrong

- A gap on the parent between `send` and the fork resolving ends the watch, so the fork's own turn never badges, though the owner's decision covers only the gapped session. It needs a parent still sending seq'd events: a Pi parent gets `ended` from `#forkOnto` in `src/server/http/session-manager.ts`, which carries no seq.
- Traced only, never run, and not introduced by OW-jadoda: forking from a parent that is itself streaming. `watchSessions` records the parent's `true`, and when the parent's own turn ends (the Pi fork aborts it; a Codex or Claude Code turn may finish during the fork), it deletes the entry, badging an unfocused tab for the parent, and `watchMove` then finds nothing to move. The existing test "badges the fork it landed on" in `src/client/App.test.ts` forks from an idle parent. Confirm or refute it with a test first.

All three are one state with the wrong owner: which session the watch belongs to is known to the controller once the fork's handle is, and `App.svelte` learns it only when the prompt resolves.
The reader's suggestion, not a decision: publish when each handle gapped (handles are never reused, per `#handlePrefix` in `SessionManager`) and have `watchSessions` void a watch whose current key gapped after it was armed, which covers the first two cases wherever the watch moves; the third needs the watch on the fork, not the parent, from the moment the fork's handle exists.

## Done when

- A test in `src/client/App.test.ts`, red first, drives the real controller through a fork whose handle gaps while its prompt POST is pending, then re-forms the fork's view streaming and then not, with the window unfocused, and no badge is raised.
- A test, red first, in which the parent gaps during the fork, then the fork's turn ends unfocused and badges.
- The streaming-parent case is either pinned by a red-first test and fixed, or shown unreachable by a test that passes against the unchanged code, and the card's close note says which.
- If the change replaces OW-jadoda's `subscribeGaps` signal, the signal and its listener in `App.svelte` are gone, not kept beside the new mechanism.
- `bun run check` passes.
