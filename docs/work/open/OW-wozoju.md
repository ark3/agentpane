---
labels: [change, emacs]
---

# agentpane-mode does not mark which user messages are fork points, so a user learns one is not only by pressing f on it (D20)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`docs/DESIGN.md` D20 makes a message no fork point names not editable.
The browser fetches the fork points at attach and at turn boundaries into `ControllerView.forkIndices` (`src/client/controller.ts`), and `forkableIndices` in `src/client/App.svelte`, passed to `src/client/render/Transcript.svelte` as its `editableIndices` prop, puts the ✎ only on the messages they name.
`agentpane-mode` marks nothing: `agentpane--fork-points` in `emacs/agentpane.el` fetches at the `f` keypress, and a message that is not a fork point answers "the message at point is not forkable" only then.

The wire is enough: `sessions/forkPoints` in `src/emacs/protocol.ts` returns `{ id, text, index }` per point.
Its server route attaches first, as the `agentpane--spawn-timeout` docstring says, so the fetch runs only for an attached buffer: fetching for a preview would spawn a backend just to draw it.
A preview therefore shows no marks, as the browser offers no ✎ on one.
The browser's behaviour is pinned by `src/client/App.test.ts` "offers no Edit on a message steering added mid-turn" and `src/client/render/Transcript.svelte.test.ts` "offers no edit control unless a composer asked for one".
How the mark looks is this card's to choose; what is load-bearing is that it is refreshed when the browser's is, at attach and at each turn boundary, so a message steering added mid-turn is not shown as forkable.

Done when an ERT test in `emacs/agentpane-test.el` draws a transcript with one fork-point user message and one steered-in user message and finds the mark on the first only, red before the change and green after.
