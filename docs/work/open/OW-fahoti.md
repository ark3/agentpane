---
labels: [change]
blocked-by: [OW-wisifo]
---

# Stop in the browser puts the text of every steered prompt Pi had not delivered back in the composer

Filed 2026-10-15 by OW-yewiku; the decision is D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects"), and OW-wisifo carries the server and wire half this card is blocked by.

On Pi, a prompt steered into a running turn may still be queued when the user presses Stop.
After OW-wisifo, the abort route sends `clear_queue` before `abort` and answers with the text of every prompt it cleared, empty on Claude Code and Codex and on a Pi with nothing queued.
This card puts that text back in the browser's composer, so nothing the user typed is lost and nothing runs after Stop.

## Where

- `abort()` in `src/client/controller.ts` (the `async abort()` that publishes `busy: "aborting"` and calls `api.abort(selected)`) receives the texts from `api.abort` in `src/client/api.ts` and publishes them into `draft`.
- The composer may already hold a draft the user started typing while the turn ran.
  Join the way Pi's interactive mode does (`restoreQueuedMessagesToEditor` in `pi 1.2.0`'s `dist/modes/interactive/interactive-mode.js`): the returned texts joined by a blank line, then the current draft after them, blank parts dropped.
  OW-seleri, the `emacs` card blocked by OW-wisifo, takes the same rule, so the two clients agree.
- Only the session the user pressed Stop on: if the selection moved while the abort was in flight, say beside the code what happens to the text, and do not drop it silently.
- Whatever OW-wisifo decided for the abort `forkAndSubmit` sends ahead of a Pi fork applies to that path in `controller.ts` too; follow that card's note at the site.
- "Stop and edit": `editLastMessage` in `src/client/App.svelte` calls `startEdit(index)`, which loads the message being edited into `draft` and stashes the old draft as `editing.stashedDraft`, and then `controller.abort()` where `stopsBeforeFork`.
  Joined into `draft` there, the returned text would be sent into the fork as part of the edit; it belongs with the stashed draft, which the edit puts back when it ends, or wherever this card decides, said at `editLastMessage`.

## Done when

- A test in `src/client/controller.test.ts`, red first, has `api.abort` answer with two texts while the draft holds other text, and asserts the draft afterwards is the two texts and then the old draft, joined by blank lines; and a second asserts an empty answer leaves the draft untouched.
- A test in `src/client/App.test.ts`, red first, drives "Stop and edit" on a Pi session whose abort answers with a text, and asserts the composer holds only the edited message and the text is where the decision above put it.
- The selection-moved decision is a comment at `abort()` in `src/client/controller.ts`, with a test if it changes behaviour.
- `bun run check` passes.
