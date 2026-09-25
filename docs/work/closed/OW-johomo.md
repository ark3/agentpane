---
labels: [change, emacs]
closed: done
---

# visual-wrap-prefix-function, run over every text part agentpane--insert-html draws, made about half of the string-pixel-width calls in a full redraw, and nothing yet says whether that cost can shrink

Found 2026-09-25 while measuring why a send stalls agentpane-mode on a long transcript (OW-yirosu), and left out of scope by OW-tujula, which cut the other half.
`agentpane--insert-html` in `emacs/agentpane.el` draws each text part through shr with filling off, then runs `visual-wrap-prefix-function` over the inserted region, narrowed, with a list-marker `adaptive-fill-regexp`, to give wrapped list rows their hanging indent; its docstring and OW-wavone say why.
`visual-wrap-prefix-function` measures prefixes with `string-pixel-width`.

## What it costs

Measured in batch Emacs 31.1 on 2026-09-25, byte-compiled, on the second full `agentpane--draw` of a stored Claude session of 348 messages and 8,298 lines, with `string-pixel-width` wrapped in counting advice: 2,398 calls in all, 1,279 of them from `agentpane--fit-header` and the other 1,119 from `visual-wrap-prefix-function`.
The draw took 262 ms, of which the fit-header calls took 88 ms; the visual-wrap calls' time was not isolated.
Batch has no fonts, and in the owner's graphical Emacs 31.1 a `string-pixel-width` call cost about 60–120 µs against batch's 45 µs (OW-tujula).
Since OW-tujula, a cut fold header costs three layouts instead of about eight, so visual-wrap is now most of what a redraw spends in `string-pixel-width`.
Every full redraw pays it: a snapshot, and the `agentpane--refit` that `agentpane--refit-on-resize` schedules on a width change, although nothing about a text part's hanging indent depends on the window's width.

## The question

Whether that pass can cost less for the same drawn result, and how: for instance by skipping lines that carry no list marker, by not re-running it where the text part is unchanged, or by computing the indent otherwise.
Load-bearing: the `wrap-prefix` a drawn text part ends up with is unchanged.
No test in `emacs/agentpane-test.el` asserts it as of 2026-09-25, so pin it first, over list rows and plain paragraphs, against today's code, before changing anything.

## Done

Either a red-then-green test in `emacs/agentpane-test.el` that counts `string-pixel-width` by advice while drawing a fixed text part of many plain lines and a few list rows, and asserts a count well below today's; or, if no cheaper path keeps the drawn result, the close note names what was tried and why each one changed the result.
Whichever way it goes, the close note gives the count for the 348-message draw before and after, or says why it could not be re-measured.

## Close note

Landed on main 2026-09-25 in three commits citing OW-johomo: e9f4f64 (pin), 2340354 (change), 074633a (docstring correction from the adversarial read).
`agentpane--insert-html` in `emacs/agentpane.el` now runs its `visual-wrap-prefix-function` pass with `string-pixel-width` bound, via `cl-letf`, to a memo keyed by `equal-including-properties` (the hash-table test `agentpane--same-text`), fresh for each text part.
visual-wrap's own logic is untouched; it offers no hook into its measure.

Where the calls came from, read in Emacs 31.1's `visual-wrap.el`: a line with an empty adaptive prefix is never measured, and a whitespace-only prefix (shr's quote indent, indented code lines) matches `adaptive-fill-first-line-regexp` and becomes its own `wrap-prefix` unmeasured.
So only lines opening with a marker are measured, two calls each — the prefix and an average-width space — and within a text part those strings repeat.
Skipping unmarked lines would therefore have saved nothing.

Counts on the second full `agentpane--draw` of stored Claude session `42788f31` (348 messages, 199 nodes, 8,297 lines), batch Emacs 31.1, byte-compiled, split by caller: visual-wrap 766 before, 142 after, over 24 distinct strings; `fit-header` 1,138, shr's own 353, unchanged.
The card's 1,119 and 8,298 could not be reproduced: the original harness was not recorded, and this one projected the session with the repo's `readSessionPreview`, `previewMessages`, `projectTranscript` and `loadRenderer` directly, no server.

Same drawn result:
- Pin `agentpane-test-text-part-hanging-indents` records every line's `wrap-prefix` and `display` runs over nested bulleted rows, numbered rows, a quote, a number-led paragraph, a fenced block and a plain paragraph; green on main's code, red with the pass skipped, with a text-only memo key, or with a forced wrong width.
- Count test `agentpane-test-list-rows-measure-once-per-text-part` (40 plain paragraphs, 12 bulleted rows in four lists): red on main's code at 26, green at 4.
- The adversarial reader compared main's function with the new one over 213 real list-bearing text parts from the 25 largest Claude session logs plus edge cases, in batch, a tty, and a graphical X frame (a private Xorg, DejaVu Sans, also with `text-scale-set 3` and a serif remap): zero differences in every `wrap-prefix` and `display` run, and 2 differences each with a text-only key, so the probe had teeth.
- It found that `equal-including-properties` is not "draws the same" in general (a two-character display spec shared versus copied; properties inside a display string); neither reaches this pass, and 074633a narrows the docstring to say so.

Suites: batch `Ran 115 tests, 112 results as expected, 0 unexpected, 3 skipped`, Commentary updated; tty `Ran 3 tests, 3 results as expected, 0 unexpected`.
Only `emacs/` changed, so `bun run check` was not run.
Filed: OW-bisima (number-led prose and `- ` code lines get a hanging indent, pre-existing, now pinned), OW-fanopi (one memo per redraw instead of per text part, 142 → ~24).
