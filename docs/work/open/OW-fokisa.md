---
labels: [change, emacs-native, now]
---

# Facts the browser transcript shows that an OW-mutufa node does not carry: timestamps, compaction tokensBefore, tool-result images

Filed 2026-09-21 from the adversarial read of OW-mutufa, which listed what `src/client/render/Message.svelte` and its tool cards draw and the node contract in `src/emacs/protocol.ts` leaves out.
None of it was in the card's scope, so it was declined there rather than missed; this card was the list, for OW-dekate and OW-wavone to pick from once a rendered buffer said what is actually missed.

Owner, 2026-09-23, after first use of the native mode on the work laptop: all of it is worth adding, so this card is no longer a deferral.
Its fifth item, the two-node `upsert` limit, is not a missing fact and moved to OW-weboto.

- Message `timestamp`: the user turn's time row, the assistant meta line's time, and the tool card's `timestamp={result?.timestamp}`.
  The browser formats it with `formatTimestamp` in `src/client/time.ts`, local `YYYY-MM-DD HH:MM:SS`, and the Emacs drawing uses that shape.
  OW-janimi reshapes the meta line's other fields and left the time to this card; where the tool's time goes depends on the one-line tool header OW-gageru settles, so carry it here and draw it there.
- `compactionSummary.tokensBefore`: the browser's marker says "from N tok"; the node carries only the summary text.
- Tool-result image parts: `resultImages` in `src/client/render/types.ts`, drawn by `ResultBody.svelte`; the contract says explicitly they are not carried.
  Drawn at least as the user's own `image` parts are today, the `[image <mime>]` line in `agentpane--insert-part`.
- The browser's `showsMeta` suppression in `Message.svelte` hides meta for a pending turn or one with no model and zero tokens; the contract deliberately sends meta on every assistant node and leaves the choice to the drawer, so this one is the drawer applying `showsMeta`'s rule in `agentpane--insert-meta`, not a contract change.

## Done when

Each of the three facts is in the `protocol.ts` docblock and the projection in `src/emacs/nodes.ts`, with a structural test in `src/emacs/nodes.test.ts` red before the change.
Each is drawn in `emacs/agentpane.el`, and the `showsMeta` rule applied, with `ert` tests in `emacs/agentpane-test.el` red before the change, that file green as its Commentary says and its pass count updated.
`bun run check` passes.
