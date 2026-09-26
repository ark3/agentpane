---
labels: [defect, emacs]
closed: done
---

# agentpane--insert-html gives a prose line opening with a number and a space, or a code line opening with "- ", a hanging indent, because its list-marker adaptive-fill-regexp cannot tell them from list rows

Found 2026-09-25 while pinning the drawn hanging indents for OW-johomo.
`agentpane--insert-html` in `emacs/agentpane.el` runs `visual-wrap-prefix-function` over each drawn text part with `adaptive-fill-regexp` bound to `"[ \t]*\\(\\([0-9]+\\.?\\|[-–*•‣⁃◦]\\)[ \t]+\\)?"`, so that wrapped list rows get a hanging indent past their marker.
A bulleted list's marker is shr's own `* ` from `shr-tag-li`, and since OW-futipo an ordered one is `1. `, drawn by `agentpane--shr-li` in the same file, but the regexp matches any line that opens with digits or a dash and then a space, wherever it came from.
So as of Emacs 31.1, a paragraph `2024 was a year.` wraps with its continuation lines aligned to column 5, and a fenced code line `- dash` wraps aligned to column 2, as neither does in the browser.

`agentpane-test-text-part-hanging-indents` in `emacs/agentpane-test.el` pins exactly that behaviour today: its expected layout carries `("2024 was a year." (space :align-to (5 . width)) …)` and `("- dash" (space :align-to (2 . width)) …)`.

In service of: text in the Emacs client wrapping as the browser's does.
Load-bearing: list rows at every depth, bulleted and numbered, keep the hanging indent the pin records; only lines that are not list rows lose it.
One route is to recognise list rows by what shr puts on them rather than by their text, for instance a property `shr-tag-li` and `agentpane--shr-li` leave on the marker; whoever takes this checks what shr actually leaves there first.

## Done

`agentpane-test-text-part-hanging-indents` changed so the `2024` paragraph and the `- dash` code line carry no `wrap-prefix`, red against today's code, and green after with every list row's entry unchanged.

## Close note

Done 2026-09-25 (6e30c5d on main).
`agentpane--insert-html` no longer lets `adaptive-fill-regexp` decide what a list row is by its text.
The regexp is now whitespace only, and an `adaptive-fill-function` returns the marker only when the marker's first character carries `shr-continuation-indentation`, which `shr-tag-li` and `agentpane--shr-li` leave there (Emacs 31.1).
So a paragraph `2024 was a year.` and a code line `- dash` no longer hang, and list rows at every depth keep the indent they had.

Verified: `agentpane-test-text-part-hanging-indents` now expects `("2024 was a year." nil nil)` and `("- dash" nil nil)`.
Against the unchanged `agentpane.el` it failed (118 run, 1 unexpected), and with the fix all 118 ran with 0 unexpected, re-run by the dispatching session in both directions.
An adversarial reader drew nested, mixed, blockquoted, table-celled and code-led lists against main and the fix: every list row's hang was unchanged, and every difference was a non-list line losing a hang it should not have had.
The one regression it found needs a user `shr-bullet` opening with whitespace; filed as OW-dulime together with the pre-existing case of a bullet outside the marker set.
