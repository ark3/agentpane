---
labels: [question, emacs]
closed: promoted
---

# An Emacs edit whose fork lands but whose prompt fails keeps the edit open, where the browser gives its draft back

Filed 2026-10-15 from OW-hakeno, which left this difference deliberately out of scope.

The browser decided in OW-kijuju that the edit's lifetime owns the draft it displaced.
One of the exits that gives that draft back is a fork whose prompt fails after the fork's attach; see the `editing` docblock in `src/client/App.svelte`.
In `emacs/agentpane.el`, `agentpane--send-edit` treats any failure the same way: fork points, the fork itself, the fork's attach or its prompt.
Each one runs `free` and leaves the edit open with the edited text in the prompt region.
Its docstring says so ("A fork or a prompt that fails leaves the edit standing").
So after a fork has landed and only its prompt failed, the Emacs parent still holds the edit.
A second `C-RET` forks again, leaving the first fork orphaned, where the browser has already moved on to the fork and given the draft back.

The fork's own buffer exists by then, which is why the two clients may reasonably differ: the browser has one composer and follows the selection to the fork, while each Emacs buffer has its own prompt region.
Decide whether Emacs should end the edit and release the displaced draft through `agentpane--release-queued` (via `agentpane--displaced`) once the fork has landed and its prompt fails, or keep the edit open.

## Done when

The decision is recorded in the `agentpane--send-edit` docstring.
If the decision is to match the browser, an ERT test in `emacs/agentpane-test.el` (run as its header says) must also be shown red first: it fails the fork's prompt after the fork answers and asserts the parent holds no edit and its region holds the displaced draft.
That test then replaces the `sessions/prompt` case of `agentpane-test-edit-send-failed-keeps-the-displaced-draft`.
If the decision is to keep the edit open, the docstring must say why the edit stays open where the browser's does not.

## Close note

Promoted to ark3/agentpane#17 during the card triage, 2026-11-01.
The owner decided agentpane-mode forks the way the browser does, and that rework decides what an edit does when its fork lands but its prompt fails, so this card is a constraint on it rather than a decision of its own.
