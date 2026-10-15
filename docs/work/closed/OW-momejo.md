---
labels: [defect]
blocked-by: [OW-fahoti]
closed: done
---

# The external editor's answer overwrites whatever reached the browser composer during its round trip

Filed 2026-10-15 from the adversarial read of OW-fahoti, which puts the text of steered prompts a Stop took out of Pi's queue back in the composer (D16 in `docs/DESIGN.md`).

`editDraft` in `src/client/controller.ts` reads `view.draft`, publishes `busy: "editing-externally"`, awaits `api.editDraft`, and then publishes `draft: edited.text` with no check that the draft is still the text it sent.
Anything that reached the composer in that window is overwritten.
Nothing stops the window filling: the textarea in `src/client/App.svelte` stays editable while the external editor is open (only the External Editor button is disabled, on `view.busy === "editing-externally"`), and the Stop button is not gated on `busy` at all.
Before OW-fahoti what was lost was typing; after it, it can be the only copy of prompts the user steered into a Pi turn and then stopped, which Pi's `clear_queue` has already removed and which exist in no file.
The sequence: Ctrl-G opens the external editor during a Pi turn with a steer queued, the user presses Stop, the stop's texts land in the composer, the editor returns and replaces them.

Two owners collide here, and that collision is the state to fix, not the one late publish.
`controller.abort` also publishes `busy: "aborting"` over `"editing-externally"`, so for the rest of the round trip the button reads as idle and the `finally` in `editDraft` (gated on `busyIs("editing-externally")`) leaves `busy` alone.
`submit` and `forkAndSubmit` already settle the same question for a sent prompt with OW-nasofa's rule, clearing the draft only "if it is still the text that was sent" (see the comment at `publish({ draft: "" })` in `submit`); the external editor's answer has no equivalent.
What the answer does when the draft moved under it — keep both, refuse the answer with an error that keeps the edited text somewhere, or block the composer and Stop for the round trip — was decided by the owner on 2026-10-15 as a first cut, to be revisited once they have seen the collision happen: keep both.
The answer keeps the editor's text and every text that reached the composer during the round trip, with nothing dropped; how the two are joined and in what order is the executor's, matching `withQueued` in `src/client/controller.ts` where that fits.
Say at `editDraft` that this is a first cut taken before the case was seen in use, and why.


The Emacs client has its own external-edit path, if any; check `emacs/agentpane.el` for the same overwrite under the "Both clients" rule in `AGENTS.md`, and file the Emacs half as an `emacs` card blocked by this one if it differs.

## Done when

- A test in `src/client/controller.test.ts`, red first, starts `editDraft`, changes the draft (by `setDraft`, standing in for typing) before `api.editDraft` resolves, and asserts the text that moved in is not lost, in whatever shape the decision above chose.
- A test in `src/client/App.test.ts`, red first, does the same with a Stop on a Pi session whose abort answers with a text.
- `bun run check` passes.

## Amended 2026-10-15 from OW-kijuju's adversarial read

Two more cases of the same collision, both found against OW-kijuju's change.

First, the External Editor can open on text already being sent.
`editDraft` and both of its triggers in `App.svelte` (Ctrl-G in `handlePromptKeydown`, and the External Editor button) gate on `view.busy === "idle"`, never on `view.sending`.
`attachAndSelect` returns `busy` to `"idle"` while a fork's prompt is still out, as the `ControllerView.sending` docblock in `src/client/controller.ts` says.
OW-kijuju made `startEdit` refuse while `view.sending` for exactly this reason: the composer holds the text the send is taking.
The external editor is the second consumer of that state, and it has no such guard.
The sequence: with a draft D, edit an earlier message (composer E) and submit.
Click another session before the fork's prompt lands, then press Ctrl-G, and `editDraft` captures E, which is in flight.
The fork lands and clears E, and OW-kijuju's release puts D back.
The editor then returns E′ and replaces D, so D is lost and an edited copy of already-sent text sits under Send.

Second, OW-kijuju's release is one more thing that reaches the composer during the round trip.
The draft an edit displaced comes back when the edit ends, and the edit can end while the editor is open.
The sequence: open an edit, press Ctrl-G, then click another session; the editor's answer then overwrites the restored draft.
The "keep both" decision above already covers this if it is implemented at the answer, not per source.

The done condition gains one test, in `src/client/App.test.ts` and red first, for the in-flight case.
Whatever the fix, it asserts the external editor never captures text a send is still taking: the editor is refused while a send is out, or its answer cannot put sent text back.

## Close note

Landed on main in four commits (OW-momejo in each subject).

The external editor's round trip is now owned by its own `ControllerView.editingExternally` flag, written only by `editDraft`, following the precedent `sending` set (OW-kelede): `abort` and `attachAndSelect` still write `busy` over `"editing-externally"`, but can no longer make a second editor openable.
The draft has one holder at a time: `editDraft` refuses while `sending`, and `submit`, `forkAndSubmit`, App.svelte's `send()` and `startEdit` refuse while `editingExternally`; Send/Fork and the External Editor button are disabled accordingly.
Typing, Stop and Cancel stay live, and what they bring in is kept at the answer, per the owner's 2026-10-15 first-cut decision "keep both": unchanged composer → the editor's text replaces it; composer `<arrivals>\n\n<text sent to the editor>` (the shape both App.svelte releases leave) → `withQueued([arrivals], edited)`; anything else → `withQueued([whole composer], edited)`, so nothing is dropped and at worst the original sits beside its rewrite.
The comment at `editDraft` records it as a first cut taken before the case was seen in use.

The adversarial read of the first round found that keeping both at the answer let a send started mid-trip leave its sent text under Send (a regression from the old overwrite) and let an edit opened mid-trip swallow the answer for Cancel to drop; the send/edit exclusion closed both.

Verified: tests in `src/client/controller.test.ts` and `src/client/App.test.ts` tagged OW-momejo, each seen red against the unfixed code or by reverting its guard (keep-both merge, Stop on Pi during the trip, abort not reopening the editor, editor refused while a fork's prompt is out, send and edit refused while the editor is open, External Editor disabled while sending, displaced draft released mid-trip kept). `bun run check` (1737 tests) and `bun run test:browser` (29) pass on main.

No Emacs half: agentpane-mode has no external-editor round trip, since Emacs is the editor, so no `emacs` card was filed.
Filed from the review: OW-nizemu (an attach a preview supersedes leaves `busy` stuck on "attaching"; OW-momejo's `settledSelection` test helper works around it and that card retires it).
