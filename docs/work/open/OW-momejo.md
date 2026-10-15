---
labels: [defect]
blocked-by: [OW-fahoti]
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
Decide what the answer does when the draft moved under it — keep both, refuse the answer with an error that keeps the edited text somewhere, or block the composer and Stop for the round trip — and say why at `editDraft`.

The Emacs client has its own external-edit path, if any; check `emacs/agentpane.el` for the same overwrite under the "Both clients" rule in `AGENTS.md`, and file the Emacs half as an `emacs` card blocked by this one if it differs.

## Done when

- A test in `src/client/controller.test.ts`, red first, starts `editDraft`, changes the draft (by `setDraft`, standing in for typing) before `api.editDraft` resolves, and asserts the text that moved in is not lost, in whatever shape the decision above chose.
- A test in `src/client/App.test.ts`, red first, does the same with a Stop on a Pi session whose abort answers with a text.
- `bun run check` passes.
