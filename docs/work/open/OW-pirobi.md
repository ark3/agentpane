---
labels: [defect, sweep-0929]
---

# A fork carries its parent's turn marks onto the fork, so a Codex or Claude Code parent whose turn ends unseen mid-fork loses its finished dot

Found 2026-09-30 by the adversarial reader of OW-vitefo, and confirmed there with a throwaway probe test driving the real `createController` (not committed).

`send()` in `src/client/App.svelte`, on the fork path, still calls `moveSessionTurnMarks(sessionTurnMarks, armedKey, landed.handle)` once `forkAndSubmit` resolves: the one piece of the old `rekeySession(armedKey, landed.handle)` that OW-vitefo kept, because `src/client/session-turns.test.ts` records the move as intended ("carries both an observed stream and a finished mark from a fork's parent to the fork").
That move is the same shape of mistake OW-koledi fixed for the badge and OW-vitefo for the follow: it treats the parent's state as the fork's, but on Codex and Claude Code the parent is a live session of its own that keeps running after the fork (D24).

The probe's sequence, Codex-shaped: a parent is streaming; the user forks and the fork takes the selection; the parent's turn ends while `api.prompt` for the fork is in flight, and the parent's row shows its finished dot (read as `["Parent turn … ●"]`); the fork resolves, the move sends `finished` for `h-parent` to `h-fork`, and because the fork is selected the next `foldSessionTurns` in `src/client/session-turns.ts` deletes it — the parent's row reads `[]`, though that turn did end unseen.
With the move removed, the dot stays.
Read but not run: if the user clicked away mid-fork, the mark lands on the fork's row instead; and the moved streaming level can overwrite the fork's own with `true`, so an unselected fork whose `status: true` has not arrived yet (D2 guarantees no cross-event order) reads `true → false` at the next fold and shows a false finished dot.
On Pi the move has no purpose either: the parent's handle is let go after the fork.
A parent turn ending after the fork resolves is marked correctly, because the next fold re-observes the parent.

Load-bearing: turn marks, like follow and the badge, belong to the session whose turn they observed, and a fork moves none of them.
The likely fix is deleting the move on the fork path, but that is the executor's to confirm, along with whether `moveSessionTurnMarks` keeps any caller — the switch effect's same-ref branch in `App.svelte` (the `$effect` whose docblock says "A key that moves while the selection stays on one ref is not a switch (OW-kimaya)") goes through `rekeySession`, which calls it for a stored session's ref-to-handle move, and that use is not in question.
Prose that states the old behaviour goes in the same change: the `moveSessionTurnMarks` docblock and the fork test in `src/client/session-turns.test.ts`, the fork-path comment in `send()` ("The parent's row marks are the one thing still carried onto the fork"), the `rekeySession` docblock, the `forkAndSubmit` docblock in `src/client/controller.ts` that names the row's turn marks as what the caller carries onto the fork, and the passage in `emacs/agentpane.el` that begins "Nothing moves a mark or a level from a fork's parent to the fork, as the browser's `moveSessionTurnMarks' does", which explains the Emacs client's behaviour against the browser's and whose Emacs half stays true.

Done when a test in `src/client/App.test.ts`, red first, drives the real controller through a fork from a streaming Codex parent whose turn ends mid-fork and asserts the parent's row keeps its finished mark after the fork resolves; the move from parent to fork is gone from the fork path; and `bun run check` passes.
