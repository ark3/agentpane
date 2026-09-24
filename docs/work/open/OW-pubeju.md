---
labels: [defect]
blocked-by: [OW-jitoni]
---

# The browser does not show a Pi session's unrestoredModel, so a resume that fell back still reads as the chosen model

OW-jitoni put `unrestoredModel` on the HTTP API's `snapshot` and `status` events (`src/shared/protocol.ts`, the docblock on the field): the model a Pi conversation's store last recorded, when the model in force is another in its place, and `null` otherwise.
The browser reduces it onto `SessionView.unrestoredModel` in `src/client/session-state.ts` and shows nothing, so a resumed session whose recorded model left the catalogue or lost its auth still reads as though the fallback were chosen, which is the gap D23 in `docs/DESIGN.md` promises to close ("runs at the model it recorded, or says why not").

In service of D23, and the browser half of the capability OW-jitoni carried onto both wires; its Emacs twin is filed beside this one.
Load-bearing: that a session whose view carries a non-null `unrestoredModel` says so before the first prompt, naming the recorded model, and that one carrying `null` shows nothing new.
Incidental: the wording, and where it sits; the model select in the composer's action row (`selectedSession.model` in `src/client/App.svelte`) is the obvious neighbour.
The server keeps the field set after the first turn on the fallback, since that turn records the fallback and no later resume can see the loss, and clears it only on a successful `setModel`; `PiAdapter`'s docblock on `unrestoredModel` in `src/server/adapters/pi/process.ts` states when it is set and cleared.
A resumed session with messages cannot change model from either client (the gate in `setModel` in `src/client/controller.ts`), so the notice cannot be dismissed by choosing a model there; whether it needs any other dismissal is this card's call.
If it lands on the composer's action row, AGENTS.md asks for `bun run test:browser` by hand before committing.

Done when a test in `src/client/**`, fed a snapshot whose `unrestoredModel` names a model, shows the notice naming it, red first and green after, and a snapshot with `unrestoredModel: null` shows none.
