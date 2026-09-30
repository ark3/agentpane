---
labels: [change, sweep-0929]
---

# The browser's favicon watch outlives a seq gap's detach, so a later snapshot under the same handle, from any client's attach, can badge a turn this tab stopped hearing; a gap should end the watch raising nothing

Filed 2026-09-30 beside OW-bepudu, which makes the same change in agentpane-mode: the owner decided that day that a `seq` gap ends the turn-done watch on that session raising nothing, in both clients, rather than keep it for a re-attach to end.
Read against 11d3ea6, nothing run.

## What happens

`detachGapped` in `src/client/controller.ts` deletes the session's view (D25 point 5 in `docs/DESIGN.md`).
The favicon watch lives in `src/client/App.svelte`, fed by the `$effect` that builds the `streaming` map from `view.state.sessions` and calls `watchSessions` in `src/client/favicon.ts`.
`watchSessions` skips a key with no view (`if (isStreaming === undefined) continue;`), because a submit's own POST can resolve before the first event forms the view, so a watch whose view a gap deleted waits on.
A later snapshot under the same handle re-forms the view (the snapshot arm of `src/client/session-state.ts` forms one for any snapshot, this tab's re-attach or another client's attach), and that turn's end badges, or a later turn's, which the watch cannot tell apart.
OW-homogu's reader showed the badge raised by driving `watchSubmit h1` then the view maps `{h1:true}`, `{}` and `{h1:false}`; OW-homogu and OW-wufiro are closed, and their bodies carry the Emacs side of the same state.

## The change

At a gap, end the watch on that session, raising nothing, whether it was still waiting to see the turn stream or had seen it.
A watch waiting on a view that has not formed yet, the case the `continue` exists for, must keep waiting.
The mechanism is the implementer's call: `detachGapped` has no route to `turnWatch` today, so it is either a signal from the controller that `App.svelte` answers with `watchAbandon`, or a rule inside `watchSessions` that tells a view that went from one that has not come.
A view deleted by a stream drop or by an `ended` also leaves its watch waiting today; say in `watchSessions`' docblock what each of those does after this change, and if the chosen mechanism ends them too, check that against OW-pohusi, which asks what a watch left standing across a stream drop should do.

## Done when

- A test, red first against the current code, in `src/client/favicon.test.ts` or `src/client/App.test.ts` wherever the mechanism lives: arm a watch, see the session stream, detach it by a gap, re-form the view under the same key streaming and then not, with the window unfocused; no badge is raised.
- The existing case that a watch armed before its view forms still badges when that turn ends stays green.
- D25 point 5 in `docs/DESIGN.md` records the decision: whichever of this card and OW-bepudu lands first writes it, and the second checks it says both clients.
- `bun run check` passes.
