---
labels: [change, emacs-native]
---

# agentpane-mode's reading view shows a bare header when it hides everything, where the browser says so

Noticed 2026-09-23 while landing OW-motuso's reading view (`agentpane-toggle-reading` in `emacs/agentpane.el`).

When reading view elides every node, as it does for a session that so far holds only tool calls and thinking, the browser draws a placeholder: "Reading view is hiding this session's tool activity and thinking" (OW-pezero; see `src/client/render/Transcript.svelte`, the branch after the `tailStatus` line).
The Emacs buffer draws only its header and the prompt, which reads as an empty or broken session.

Draw an equivalent line when reading view is on and `agentpane--elided-p` holds for every node in the ewoc, and not otherwise.
It must not be buffer text that `n`, `p` or `agentpane-index-at-point` can land on; the tail status in OW-motuso is an overlay string on the prompt separator for the same reason.

## Done when

An `ert` test in `emacs/agentpane-test.el` draws nodes that are all tool chrome, turns reading on, and asserts the placeholder is visible, then turns it off and asserts it is gone; a second draw with one text node asserts it is absent with reading on.
Shown red before the change; the pass count in `emacs/agentpane.el`'s Commentary updated.
