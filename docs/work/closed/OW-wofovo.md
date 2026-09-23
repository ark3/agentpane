---
labels: [change, emacs-native]
closed: done
---

# agentpane-mode's reading view shows a bare header when it hides everything, where the browser says so

Noticed 2026-09-23 while landing OW-motuso's reading view (`agentpane-toggle-reading` in `emacs/agentpane.el`).

When reading view elides every node, as it does for a session that so far holds only tool calls and thinking, the browser draws a placeholder: "Reading view is hiding this session's tool activity and thinking" (OW-pezero; see `src/client/render/Transcript.svelte`, the branch after the `tailStatus` line).
The Emacs buffer draws only its header and the prompt, which reads as an empty or broken session.

Draw an equivalent line when reading view is on and `agentpane--elided-p` holds for every node in the ewoc, and not otherwise.
Match the browser's two further conditions, found when this card was executed on 2026-09-23: it draws the line only when there is at least one node (`fullView.entries.length > 0`, so an empty session keeps its empty look), and never while the tail status shows (`{#if !tailStatus}`), since that line already says what is happening.
It must not be buffer text that `n`, `p` or `agentpane-index-at-point` can land on; the tail status in OW-motuso is an overlay string on the prompt separator for the same reason.

## Done when

An `ert` test in `emacs/agentpane-test.el` draws nodes that are all tool chrome, turns reading on, and asserts the placeholder is visible, then turns it off and asserts it is gone; a second draw with one text node asserts it is absent with reading on.
Shown red before the change; the pass count in `emacs/agentpane.el`'s Commentary updated.

## Close note

Built in 368bfaa: `agentpane--hiding-everything-p` in `emacs/agentpane.el` holds when reading view is on, the ewoc has at least one node, and `agentpane--shown` finds none drawn; `agentpane--show-reading-tail` now puts the browser's "Reading view is hiding this session's tool activity and thinking." line in `agentpane--tail-overlay`'s `before-string` when there is no tail status, which wins as `{#if !tailStatus}` does in `Transcript.svelte`.
An overlay string, so no node navigation lands on it; the existing refresh sites (`agentpane--draw`, `agentpane--upsert`, the toggle, `agentpane--set-status`) already covered every change, so none were added.
The card was amended at execution to carry the browser's two extra conditions, a non-empty transcript and no tail status.
Verified: `agentpane-test-reading-view-says-it-hides-everything` (the done condition) and `agentpane-test-reading-view-hiding-line-follows-the-nodes` (snapshot, `session/node`, streaming tail status, empty snapshot) both failed against the old `agentpane.el` on `(should (agentpane-test--hiding-p))`, re-run by the dispatching session; the full ert suite runs 76 of 76 as expected, and the Commentary says so.
The browser's other two empty-transcript lines are filed as OW-fikuli.
