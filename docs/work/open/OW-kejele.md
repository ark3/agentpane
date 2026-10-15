---
labels: [change]
---

# storedAgentMessage never names an assistant's errorMessage, so the error text both clients draw reaches the preview only through a spread no test holds

Filed 2026-10-14 by the execution of OW-tadoju, whose store survey listed `message(assistant).errorMessage` under "keys carried to the wire unnamed, by a spread" (`docs/MANUAL_TESTING.md`, "The home server's Pi store, surveyed for what agentpane does not read (OW-tadoju)").

The `assistant` arm of `storedAgentMessage` in `src/server/sessions/preview-message.ts` builds the turn from `...stored` plus the fields it names, and `errorMessage` is not among them.
Both clients read it by name on a reply whose `stopReason` is `error`: `src/client/render/Message.svelte` (`turn.errorMessage || "The turn ended in an error."`) and `src/emacs/nodes.ts`.
So a stored error reply shows its text only because of the spread, and nothing in `src/server/sessions/` tests it: a refactor that narrows the spread would replace every stored error's text with the fallback and stay green.

In service of the preview keeping what the clients depend on by contract rather than by accident.
Naming the field and testing it is the whole card; narrowing or removing the spread is not.

## Done when

A test beside the existing `storedAgentMessage` / Pi preview tests asserts that a stored assistant message with `stopReason: "error"` and an `errorMessage` yields a preview turn carrying that `errorMessage`, shown red by temporarily dropping the spread, and the assistant arm names `errorMessage` so the test holds without the spread.
