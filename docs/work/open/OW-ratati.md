---
labels: [defect, emacs]
---

# agentpane-mode's turn-done indicator signals inside the status handler when the user's global-mode-string is a string

Filed 2026-09-27 from the adversarial read of OW-lohavi.

`agentpane--watch-turn` in `emacs/agentpane.el` raises the indicator with the `time.el` idiom, `(or global-mode-string (setq global-mode-string '("")))` then `add-to-list 'global-mode-string '(:eval (agentpane--turn-done-lighter)) t`.
That is right for nil or a list of mode-line elements, and wrong for the other forms `global-mode-string` may take as a mode-line construct:

- A string, such as `"USER"`: `add-to-list` signals `(wrong-type-argument listp "USER")`.
  It signals inside `agentpane--set-status`, before the tail redraw and the mode-line refresh that follow the watch, so the transcript's mode line keeps reading `streaming` after the turn ended, at every raise.
- A single construct such as `(:eval ...)` or a `(SYMBOL THEN ELSE)` conditional: the appended entry becomes part of that construct and is never drawn (observed as `(:eval (format "X") (:eval (agentpane--turn-done-lighter)))`).

Both were reproduced on Emacs 31.1 against a scratch copy in the review.
What is load-bearing is that a user's own `global-mode-string` neither breaks status handling nor hides the indicator; whether the fix wraps a non-list value into a list, uses another mode-line slot, or otherwise, is this card's to choose.

Done when an ERT test in `emacs/agentpane-test.el` with `global-mode-string` let-bound to a string raises the indicator and leaves the buffer's streaming state updated, red before the change and green after, and the existing `agentpane-test-turn-done-*` tests stay green.
