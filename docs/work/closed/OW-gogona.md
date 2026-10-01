---
labels: [deferral, emacs, sweep-0929]
closed: done
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

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) confirmed the location above and took the fix in `toolSummary` as the one that settles both clients, since `src/emacs/nodes.ts` builds Emacs tool parts from the same helper.
OW-vipiso fits headers through the same `fits` closure in `agentpane--fit-header`, so the `\n` fallback retired here is one of the two escape hatches that closure forced; leave the other, the selected-frame test in `agentpane--motion-window`, to OW-vipiso.

## Amended 2026-10-01

Checked against `main` at dbc6e26: `toolSummary`, `basename`, `oneLine`, `agentpane--fit-header` and `agentpane--cut-by-motion` all stand as described.
The Done section's red-then-green cannot live in `emacs/agentpane-test.el` for a fix in `toolSummary`: those `ert` tests draw fixed nodes with no helper process, so no TypeScript change can turn one green.
For that fix the red-then-green lives in vitest beside `toolSummary` — `src/emacs/nodes.test.ts` covers the Emacs projection — and `emacs/agentpane-test.el` stays green with the `\n` fallback retired.

## Close note

Fixed where the summary is built, so both clients are settled at once.
`toolSummary` in `src/client/render/tools/summary.ts` now collapses whitespace over the whole returned string (`/\s+/g` to one space, trimmed), so no Read, Write, Edit, subagent or later branch can carry a newline or tab; it deliberately does not use `oneLine`, whose 120-character cut would shorten long file names that each client already cuts to fit.
One visible side effect: a collab summary whose thread ids are empty strings ends "wait ·" rather than "wait · ".
Pinned by a vitest in `src/emacs/nodes.test.ts` ("keeps a newline or tab in a file name or a collab operation off the one-line header"), red against the old `summary.ts` (`expected 'odd\nname.ts · offset 3' not to match /[\t\n\r]/`) and green after; `bun run check` passed (1613 tests).
In `emacs/agentpane.el`, `agentpane--cut-by-motion`'s fallback now tests only `\t`, and the docstring sentence about `string-pixel-width` measuring the widest line is gone, with the `"abc\ndef …"` case dropped from the tty test `agentpane-test-motion-cuts-where-the-search-does`.
The tab half stays because it is still reachable: `agentpane--insert-thinking` fits a thinking part's first line, which may hold a tab; the docstring now says so.
The selected-frame test in `agentpane--motion-window` was left to OW-vipiso.
ert on Emacs 31.1: batch 241 run, 238 as expected, 3 skipped; the three tty tests passed under `emacs -nw`.
Browser: such a summary was already drawn on one line before the fix, because the tool card's `.summary` (`ToolCard.svelte`) and the reading-view tail's `.tail-summary` (`Transcript.svelte`) are `white-space: nowrap`, which collapses a newline to a space; only their `title` tooltip carried the raw newline, and it now carries the collapsed text.
Not done: the head (tool name) and tail (step meta) handed to the motion are not checked for a tab or newline; whether any backend can put one in a tool name was not checked, and nothing was filed.
