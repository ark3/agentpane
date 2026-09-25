---
labels: [change, emacs]
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
