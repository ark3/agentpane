---
labels: [defect, emacs]
closed: done
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

## Close note

Landed in efe4b7a on main (2026-09-27).
`agentpane--watch-turn` now wraps a `global-mode-string` that is not a list of mode-line elements -- one whose first element is neither a string nor a list, so a string, an `(:eval ...)`, a `(SYMBOL THEN ELSE)` conditional or a width form -- into `("" VALUE)` before appending the indicator entry; nil still becomes `("")`, and lists of elements such as time.el's are left alone so packages that `delq` their own top-level entries still can.
The indicator stays in `global-mode-string`, so the docblock needed no change; another slot such as `mode-line-misc-info` was rejected because a custom mode line may not draw it.
New ERT test `agentpane-test-turn-done-raised-beside-a-users-own-construct` runs with `global-mode-string` let-bound to `"USER"` and to `(:eval (format "X"))`, and asserts `streaming` is gone from `agentpane--status-fields` (set after the watch, unlike `agentpane--streaming`, which is set before it and so could not go red), the indicator is raised, and the user's value is still an element.
`agentpane-test--turn-done-p` now reads entries only from a list of elements, as the mode line does; before, it read the swallowed `(:eval (format "X") (:eval ...))` tail as entries and passed falsely.
Verified by the dispatching session against main's old `agentpane.el`: the string case failed with `(wrong-type-argument listp "USER")`, the `:eval` case alone failed `(should (agentpane-test--turn-done-p))`; with the fix the full suite ran 154, 151 as expected, 0 unexpected, 3 skipped (interactive-only).
The test macro's leak of `global-mode-string` across tests went to OW-zowuji.
