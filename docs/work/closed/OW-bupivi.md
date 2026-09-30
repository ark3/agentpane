---
labels: [change, emacs]
closed: done
---

# agentpane-mode has no command that only attaches a previewed session, as the browser's Attach button does

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

While a session is previewed, the browser swaps the composer for an Attach button (`attachSelected` in `src/client/App.svelte`), which opens the live session and focuses the prompt without sending anything.
In `emacs/agentpane.el` a preview attaches only as a side effect of something else.
A send and `agentpane-compact` attach through `agentpane--attached-then`, `agentpane-fork` through `agentpane--attach`, and interactive `agentpane-set-model` and `agentpane-set-effort` through `agentpane--attach-now`.
The `agentpane-fork` docstring states the gap: "there is no command that only attaches".

The wire is enough: `sessions/attach` exists.
The browser's behaviour is pinned by `src/client/App.test.ts` "swaps the composer for an Attach button while previewing, opens the live session, and focuses the prompt".

Done when an ERT test in `emacs/agentpane-test.el` runs the new command on a preview buffer and sees `sessions/attach` sent and the buffer attached, red before the change and green after.
The `agentpane-fork` docstring's sentence is retired in the same change.

## Amended 2026-09-29 under D26

OW-zavehi's decision, D26 in `docs/DESIGN.md`, point 7, makes this command required rather than optional: once `agentpane--dropped` goes, `g` in a buffer that is not attached previews, and this command is how such a buffer goes live without sending anything.
OW-vugefa is blocked by this card for that reason.

## Close note

Built `agentpane-attach` in `emacs/agentpane.el`, bound to `a` in `agentpane-transcript-mode-map`: it attaches the buffer's session through `agentpane--attached-then`, sending nothing, and once attached moves point to the end of the prompt region in the buffer and in the window the press came from, as the browser's Attach (`attachSelected`) focuses the prompt.
An attached buffer only moves point; one already attaching joins that attach; a close in flight refuses through `agentpane--refuse-closing`; a failed attach moves nothing; other windows showing the buffer keep their points.
It refuses while `agentpane--forking` is set, as `agentpane-fork` and `agentpane-edit` do, because a Pi fork's parent let go by `ended` before the fork's reply would otherwise be re-attached and respawn its old branch; the adversarial read found `agentpane-send` and `agentpane-compact` miss that guard, and OW-nuhayu moves the refusal into `agentpane--attach` and retires this site guard.
`agentpane-fork`'s docstring no longer rests on there being no command that only attaches, and its "unordered (D2)" sentence now says the "press f again" message follows the redraw, since OW-rebawa has the helper write the attach reply after its snapshot.
Tests: `agentpane-test-attach-on-a-preview-attaches-and-goes-to-the-prompt` (attach held, then failed, then answered; draft in the prompt region; pressing and second window) and `agentpane-test-attach-during-a-fork-sends-nothing` (on `agentpane-test--detached`), red before (void function) and against seven mutations each pinned by its own assertion, green after; the suite ran 219 tests, 216 as expected, 0 unexpected, 3 skipped.
