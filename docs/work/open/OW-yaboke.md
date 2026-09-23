---
labels: [change, emacs-native]
---

# agentpane-mode's compaction marker reads the raw role compactionSummary where the browser reads Context compacted

Noticed 2026-09-23 while landing OW-fokisa.

`agentpane--pp-node` in `emacs/agentpane.el` draws any node whose role is neither `user` nor `assistant` with its role string as a header line in `agentpane-role-other`, so a compaction seam reads `compactionSummary`, or since OW-fokisa `compactionSummary · from 28K tok`, through `agentpane--role-suffix`.
The browser draws the same seam in the `compactionSummary` branch of `src/client/render/Message.svelte` as a divider reading "Context compacted", with "from N tok" after it when `tokensBefore` is above 0.
No card chose the Emacs wording: it is the generic fallback for unknown roles.

Draw the compaction node as a marker carrying the browser's words, "Context compacted" plus the size when above 0, and keep the generic fallback for other roles.
Whether it is drawn as a rule-like divider line is a first cut to state in the close note.

## Done when

An `ert` test in `emacs/agentpane-test.el` draws a `compactionSummary` node with `tokensBefore` 28000 and asserts `Context compacted` and `from 28K tok` appear and the raw string `compactionSummary` does not; it is shown red before the change.
The pass count in `emacs/agentpane.el`'s Commentary is updated.
