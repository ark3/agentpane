---
labels: [deferral, emacs]
---

# A tool summary holding a newline draws a two-line fold header in agentpane-mode, because string-pixel-width measures only its widest line

Found 2026-09-25 by the adversarial read of OW-tujula.
`agentpane--fit-header` in `emacs/agentpane.el` fits each folded header to one screen line by measuring it with `string-pixel-width`, which measures the widest line of a string that holds a newline, not its total width.
So a summary like `"abc\ndef 1 2 3 …"` passes as fitting, and the header is drawn over two lines: in an 80x24 tty Emacs 31.1 the search kept `"✓ Bash abc\ndef 1 2 3 4…"` at 13 columns.
OW-tujula kept that behaviour on purpose, so that its `vertical-motion` cut stayed equal to the search's: `agentpane--cut-by-motion` sends a summary holding `\n` to `agentpane--cut-by-search`, and its docstring says why.

## Where the newline comes from

`toolSummary` in `src/client/render/tools/summary.ts` collapses whitespace with `oneLine` for the shell and the generic summaries, but not for `basename(path)` in the Read, Write and Edit summaries, nor for the subagent `tool` argument.
So it takes a newline in a file name, or in a Codex collab operation name, and is rare.
The thinking header is not affected: `agentpane--insert-thinking` splits at the first newline before fitting.
How the browser draws such a summary was not checked.

## Done

A summary holding a newline draws a one-line header, which red-then-green in `emacs/agentpane-test.el` pins, and the browser's behaviour for the same summary is stated in the close note.
Whether to fix it where the summary is built (`toolSummary`, both clients at once) or where Emacs draws it is the executor's call; the close note says which and why.
Once no summary reaching `agentpane--fit-header` can hold a newline, the `\n` in `agentpane--cut-by-motion`'s fallback is dead, so the same change retires it and the docstring sentence behind it.
