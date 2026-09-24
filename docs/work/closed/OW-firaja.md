---
labels: [defect, emacs]
blocked-by: [OW-jitoni]
closed: done
---

# Emacs does not show a Pi session's unrestoredModel, so a resume that fell back still reads as the chosen model

OW-jitoni put `unrestoredModel` on the Emacs helper's `session/snapshot` and `session/status` (`src/emacs/protocol.ts`, the paragraph beginning "`session` in every payload is a ref"): the model a Pi conversation's store last recorded, when the model in force is another in its place, and `null` otherwise.
`emacs/agentpane.el` reads neither, so a resumed session whose recorded model left the catalogue or lost its auth still shows the fallback in the mode line as though it were chosen, which is the gap D23 in `docs/DESIGN.md` promises to close ("runs at the model it recorded, or says why not").

In service of D23, and the Emacs half of the capability OW-jitoni carried onto both wires; its browser twin is filed beside this one, and the Emacs client stays at parity with it (AGENTS.md, "Both clients").
Load-bearing: that a buffer whose status carries a non-null `:unrestoredModel` says so before the first prompt, naming the recorded model, and that one carrying `null` shows nothing new.
Incidental: the wording, and where it sits; `agentpane--set-status` builds `agentpane--status-fields`, which `agentpane--show-mode-line` shows, and the model is already one of those fields.
The server keeps the field set after the first turn on the fallback and clears it only on a successful `sessions/setModel`; `PiAdapter`'s docblock on `unrestoredModel` in `src/server/adapters/pi/process.ts` states when it is set and cleared.
A resumed session with messages cannot change model from Emacs (`agentpane--check-gate`), so the notice cannot be dismissed by choosing a model there.

Done when an ERT test in `emacs/agentpane-test.el`, fed a status whose `:unrestoredModel` names a model, shows the buffer naming it, red first and green after, and a status with `:unrestoredModel nil` shows nothing new.

## Close note

Landed in 9e2be01.
`agentpane--set-status` in `emacs/agentpane.el` now renders the model field as `MODEL (RECORDED not restored)`, with the bracket in `agentpane-warning` face, whenever the status or snapshot carries a non-null `:unrestoredModel`; a null field leaves the mode line unchanged, and there is no client-side dismissal because the display follows the server's field.
The mode line was chosen because it already names the model and this qualifies it; a first cut, and a line in the buffer is the alternative if a narrow window truncating the mode line turns out to hide it.
Verified by the ERT test `agentpane-test-mode-line-names-the-unrestored-model`, red against the pre-change `agentpane.el` and green after, with the full ERT suite at 89/89.
The browser twin was OW-pubeju.
