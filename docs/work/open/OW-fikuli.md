---
labels: [change, emacs-native]
---

# agentpane-mode draws neither of the browser's empty-transcript lines, Waiting for the agent… and No messages yet.

Noticed 2026-09-23 while landing OW-wofovo, which gave `emacs/agentpane.el` the browser's reading-view line for a transcript it elides entirely.

`src/client/render/Transcript.svelte` has two more placeholders in the same `{#if}` chain, right after the `data-reading-elided` branch:
"Waiting for the agent…" (`class="waiting"`) while streaming with nothing drawn and no tail status, and "No messages yet." when not streaming and there are no nodes.
agentpane-mode draws neither, so a fresh or empty session shows only its header and the prompt, which reads as broken.

OW-wofovo put its line in `agentpane--show-reading-tail` as the `before-string` of `agentpane--tail-overlay` on the prompt separator, chosen with `agentpane--reading-tail` first and `agentpane--hiding-everything-p` second.
These two belong in the same chain and for the same reason: an overlay string is no buffer text that `n`, `p` or `agentpane-index-at-point` can land on.
The browser's conditions are the spec, including that "Waiting" defers to the tail status; read them at the site rather than from this card.
Every path that changes the nodes or the streaming status already calls `agentpane--show-reading-tail` (`agentpane--draw`, `agentpane--upsert`, `agentpane-toggle-reading`, `agentpane--set-status`), per OW-wofovo's review.

## Done when

`ert` tests in `emacs/agentpane-test.el` show each line under the browser's condition and not otherwise — an empty snapshot not streaming shows "No messages yet.", a streaming one with no nodes shows "Waiting for the agent…", and neither shows once a drawn node arrives — shown red before the change, with the pass count in `emacs/agentpane.el`'s Commentary updated.
The helper `agentpane-test--above-prompt` there returns whatever that overlay shows.
