---
labels: [change, emacs-native, now]
---

# agentpane-mode has no reading view, the browser's toggle that elides tool calls, tool results and thinking

Owner, 2026-09-23, first use of the native mode on the work laptop against Claude Code: "I really really miss reading view -- I use it a lot in the web UI."
No Emacs card ever carried it; OW-mikuyo's "reading-mode UI" was a session browser, which OW-wavone built as the picker, not this.

## What the browser does

OW-51 built it and its close note records the decisions taken with the owner.
The rule is `condense` in `src/client/render/transcript.ts`, whose docblock opens "Reading view (OW-51)": tool results are dropped, orphans included; tool calls and thinking are filtered out of assistant turns; a turn left with nothing is dropped unless its `stopReason` is `error` or `aborted`, whose banner is not tool chrome; user turns are untouched.
Entries keep their original index.
While streaming, `readingTailStatus` in the same file names the live tool or thinking step the elision would otherwise hide, and `Transcript.svelte` draws it below the transcript.

## What the Emacs side has

Nodes arrive already projected (`src/emacs/protocol.ts`, the docblock's "Node" and "Parts" lists): a tool result is folded into its `tool` part, and a result whose call is absent is a node with `role: "tool-result"`.
So the Emacs rule is the same rule over nodes: drop `tool-result` nodes, drop `tool` and `thinking` parts, and drop an assistant node left with no parts unless its `meta.stopReason` is `error` or `aborted`.
Drawing is `agentpane--pp-node` and `agentpane--insert-part` in `emacs/agentpane.el`; the ewoc holds every node whichever way the toggle is set, so a toggle is a redraw rather than a refetch, and `upsert` keeps working on the full list.
Node `index` is what `n`, `p`, `f` and `agentpane-index-at-point` read, and it is the node's own field, so eliding nodes does not renumber anything.
Fold state (`agentpane--folds`) is keyed by index and part ordinal; a part's ordinal must stay its ordinal in the node's `parts`, not its position among the survivors, or folds expanded before the toggle open the wrong part after it.
With reading on and `agentpane--streaming` set, the mode line or a line above the prompt names the running tool or thinking, from the last assistant node's last `tool` or `thinking` part, per `readingTailStatus`'s stopping rules.

## Decisions

Owner, 2026-09-23:
- The toggle is per buffer and not persisted: each transcript buffer has its own, where the browser has one global boolean.
- The key is `r` in `agentpane-transcript-mode-map`, and the mode line says when reading is on, since a buffer with no tool calls otherwise looks the same either way.
- The live tail status above is in, as in the browser.
- Thinking is hidden, as in the browser; that is still OW-51's first cut, not a settled decision.

## Done when

New `ert` tests in `emacs/agentpane-test.el`, run as that file's Commentary says, each red before the change:
- `r` in one transcript buffer turns reading on there and not in a second one;
- with reading on, a rendered fixture holding a tool call, a thinking part and a `tool-result` node shows none of their summary lines while its user and assistant text remain, and toggling back shows them again;
- an assistant node holding only a tool call is absent with reading on, while one with `stopReason` `aborted` and no parts keeps its warning meta line;
- `agentpane-index-at-point` on an assistant node after an elided node returns that node's original index;
- a fold expanded before the toggle is still expanded on the same part after toggling twice;
- with reading on and the buffer streaming, the tail status names the last node's running tool.
The whole file stays green, with the pass count in the Commentary updated.
The owner has used the toggle on a live Claude session on the work laptop.
