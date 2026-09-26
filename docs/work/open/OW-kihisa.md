---
labels: [change, emacs]
---

# agentpane-mode cannot take an earlier message back into the composer to edit and fork with, as the browser's pencil control does

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's ✎ on a user message fills the composer with that message's text and images, marks the message and dims those after it, offers Cancel and Escape, and on send forks at that message and prompts the fork.
It is `startEdit`, `cancelEdit`, `send` and the `editing` state in `src/client/App.svelte`, `forkAndSubmit` in `src/client/controller.ts`, and `editingIndex` in `src/client/render/Transcript.svelte`.
`agentpane-fork` (`f`) in `emacs/agentpane.el` forks at point into a buffer with an empty composer: nothing is prefilled and the message's images are not carried.

The wire already carries what this needs.
User nodes hold the message's text and its base64 image parts, and the helper has `sessions/forkPoints`, `sessions/fork` and `sessions/prompt` with `images?` (`src/emacs/protocol.ts`).

The browser's behaviour is pinned by `src/client/controller.test.ts` "forks at the point naming that transcript index and only then prompts", and by `src/client/App.test.ts` "carries an edited message's images into the fork", "cancels an edit on a click" and "also cancels an edit on Escape".
`docs/DESIGN.md` D20 makes a message no fork point names not editable, and `startEdit` refuses one at the press.
The Emacs edit refuses at the press too, checking the points as `agentpane--fork-points` does, rather than prefilling and failing at send.
On a preview buffer, `agentpane-fork` attaches first because a preview's indices can differ from the live ones (its docstring, OW-gekiki), and the edit needs the same.
A node's image part carries `{ mimeType, data }` (`src/emacs/protocol.ts`), while the prompt's `images` take `{ mimeType, base64 }` (`PromptRequest` in `src/shared/protocol.ts`).

The Emacs shape of the gesture is this card's to choose.
What is load-bearing is that the edited text and the message's images both reach the fork's first prompt, and that an edit can be abandoned without forking anything.

Done when ERT tests in `emacs/agentpane-test.el`, run as that file's Commentary says, go red before the change and green after: one edits a message holding an image and sees the fork prompted with the edited text and that image, and one abandons an edit and sees no `sessions/fork` sent.
