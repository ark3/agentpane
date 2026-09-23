---
labels: [change, emacs-native]
closed: done
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

## Close note

Landed in 0bcb815.
`agentpane--pp-node` in `emacs/agentpane.el` now gives `compactionSummary` its own branch, drawing one line from `agentpane--compaction-marker` (which replaced `agentpane--role-suffix`): `── Context compacted · from 28K tok ──`, the size only when `tokensBefore` is above 0, in face `agentpane-dim`.
Every other role that is neither user nor assistant keeps the generic `agentpane-role-other` header.

First cut, per the card: a rule-like divider made of short fixed `──` rules either side, copied from the prompt separator's `── prompt · C-RET sends ──` rather than rules that fill the window, which would have to be redrawn on every resize.
The ` · ` stands in for the browser's CSS gap between label and size.
It is dim, like the browser's muted marker, where the old face was bold.
The Pi summary text still draws below it as a text part, because `src/emacs/nodes.ts` projects it into `parts`.

Verified: `agentpane-test-compaction-marker-reads-as-the-browser` in `emacs/agentpane-test.el` replaced `agentpane-test-compaction-marker-names-tokens-before`.
It draws a marker at `tokensBefore` 28000 and one at 0, and asserts that `Context compacted` appears twice, `from 28K tok` appears, `tok` appears exactly once, and `compactionSummary` never appears.
Against the old code it failed with `(= 2 0)` on `Context compacted`.
On Emacs 31.1 the full suite ends `Ran 74 tests, 74 results as expected, 0 unexpected`.
The Commentary's count already read 74 and still does, because the test was replaced rather than added.
`bun run check` passed.
