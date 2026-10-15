---
labels: [change]
blocked-by: [OW-wisifo]
closed: done
---

# Stop in the browser puts the text of every steered prompt Pi had not delivered back in the composer

Filed 2026-10-15 by OW-yewiku; the decision is D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects"), and OW-wisifo carries the server and wire half this card is blocked by.

On Pi, a prompt steered into a running turn may still be queued when the user presses Stop.
After OW-wisifo, the abort route sends `clear_queue` before `abort` and answers with the text of every prompt it cleared, empty on Claude Code and Codex and on a Pi with nothing queued.
As landed, that is `AbortResponse` (`{ queued }`) in `src/shared/protocol.ts` with a 200 when anything was cleared, and a bodiless 204 otherwise, so `api.abort` resolves `AbortResponse | void`.
OW-wisifo also has `PiAdapter.submit` refuse a prompt while a stop is awaiting Pi's answer, which reaches the browser as an ordinary failed send that keeps its draft.
This card puts that text back in the browser's composer, so nothing the user typed is lost and nothing runs after Stop.

## Where

- `abort()` in `src/client/controller.ts` (the `async abort()` that publishes `busy: "aborting"` and calls `api.abort(selected)`) receives the texts from `api.abort` in `src/client/api.ts` and publishes them into `draft`.
- The composer may already hold a draft the user started typing while the turn ran.
  Join the way Pi's interactive mode does (`restoreQueuedMessagesToEditor` in `pi 1.2.0`'s `dist/modes/interactive/interactive-mode.js`): the returned texts joined by a blank line, then the current draft after them, blank parts dropped.
  OW-seleri, the `emacs` card blocked by OW-wisifo, takes the same rule, so the two clients agree.
- Only the session the user pressed Stop on: if the selection moved while the abort was in flight, say beside the code what happens to the text, and do not drop it silently.
- Whatever OW-wisifo decided for the abort `forkAndSubmit` sends ahead of a Pi fork applies to that path in `controller.ts` too; follow that card's note at the site.
  It decided to drop what that abort clears, which loses those words outright when the fork's abort is the first stop, as when a past message is edited while a turn streams with a steer queued; if this card finds a place for them after all, change the note there.
- "Stop and edit": `editLastMessage` in `src/client/App.svelte` calls `startEdit(index)`, which loads the message being edited into `draft` and stashes the old draft as `editing.stashedDraft`, and then `controller.abort()` where `stopsBeforeFork`.
  Joined into `draft` there, the returned text would be sent into the fork as part of the edit; it belongs with the stashed draft, which the edit puts back when it ends, or wherever this card decides, said at `editLastMessage`.

## Amended 2026-10-15, at review

The first cut joined the texts into `draft` inside the controller and let "Stop and edit" alone divert them through a callback.
Its adversarial read found the plain Stop button, shown whenever a turn streams and edit mode or not, still joining them into an open edit's text, where "Stop and fork" sends them into the fork and Cancel overwrites them: reached by clicking a transcript message's edit control during a Pi turn and then Stop, or Stop and then "Stop and edit" before the first stop answers.
Where the words go depends on what the composer holds when the answer lands, which only `App.svelte` knows, so `controller.abort()` resolves with the texts and leaves the draft alone, and App places them for every stop through one rule.
The join rule and the decisions above are unchanged; the done-conditions below replace the original ones, which put the draft assertions on the controller.

## Done when

- A test in `src/client/controller.test.ts` asserts `abort()` resolves with the texts in order, and with none on a 204.
- Tests in `src/client/App.test.ts`, each red first: a plain Stop answered with two texts while the draft holds other text typed during the round trip leaves the texts and then that draft, joined by blank lines; one answered with nothing leaves the draft untouched; "Stop and edit" whose abort answers with a text leaves the composer holding only the edited message and the text where the decision above put it; and a plain Stop during an open edit does the same.
- The selection-moved decision is a comment where App puts the texts in the composer, with a test if it changes behaviour.
- `bun run check` passes.

## Close note

Landed 2026-10-15 on main as 5157ff59 and 65d44d5b.
`controller.abort()` in `src/client/controller.ts` now resolves with the texts the abort route cleared from Pi's queue (`AbortResponse.queued`, in order; none on a 204, a failure or a no-op) and never writes the draft.
`App.svelte` routes both stops, the Stop button and "Stop and edit", through one `stop()` that appends them to `heldQueued`; a `$effect` releases them with `withQueued` (exported from `controller.ts`, Pi 1.2.0's `restoreQueuedMessagesToEditor` rule verbatim: texts joined by blank lines, then the current draft, blank parts dropped) once no edit is open and `view.sending` is false, which for a plain Stop is at once.
So the words never enter an edit's text: Cancel puts the displaced draft back and they land ahead of it; a fork's prompt lands and they fill what it leaves; a session switch, or a fork whose prompt fails after its attach moved the selection, ends the edit and they join ahead of the leftover text, now only a draft.
Decisions, at the site: a selection that moved during the stop changes nothing, because the draft is global and the words reached no session (comment at the release effect, noting OW-zigepi would change it); the abort `forkAndSubmit` sends ahead of a Pi fork still drops what it clears, as OW-wisifo decided.
The card was amended at review: the first cut joined into the draft in the controller and diverted only "Stop and edit", and the adversarial read showed a plain Stop during an open edit (transcript edit control, then Stop) put the words into the fork or under Cancel's overwrite.
Verified: tests in `controller.test.ts` (resolves with texts / none) and `App.test.ts` (plain Stop joins ahead of a draft typed meanwhile; empty answer leaves a `"\n\n"` draft alone; Stop and edit then Cancel; fork with the answer before and while the fork is out, asserting the fork's prompt body; plain Stop during an open edit, confirmed red against the first cut by the dispatching session); `bun run check` 1700 passed; `bun run test:browser` 29 passed.
Not tested, documented only: the release after a session switch, and after a fork whose prompt fails post-attach.
Filed from the execution: OW-momejo (external editor's answer overwrites the restored words) and OW-kijuju (a landed fork drops the edit's displaced draft).
