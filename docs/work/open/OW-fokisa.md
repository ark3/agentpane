---
labels: [deferral, emacs-native, now]
---

# Facts the browser transcript shows that an OW-mutufa node does not carry: timestamps, compaction tokensBefore, tool-result images

Filed 2026-09-21 from the adversarial read of OW-mutufa, which listed what `src/client/render/Message.svelte` and its tool cards draw and the node contract in `src/emacs/protocol.ts` leaves out.
None of it was in the card's scope, so it was declined there rather than missed; this card is the list, for OW-dekate and OW-wavone to pick from once a rendered buffer says what is actually missed.

- Message `timestamp`: the user turn's time row, the assistant meta line's time, and the tool card's `timestamp={result?.timestamp}`.
- `compactionSummary.tokensBefore`: the browser's marker says "from N tok"; the node carries only the summary text.
- Tool-result image parts: `resultImages` in `src/client/render/types.ts`, drawn by `ResultBody.svelte`; the contract says explicitly they are not carried.
- The browser's `showsMeta` suppression in `Message.svelte` hides meta for a pending turn or one with no model and zero tokens; the contract deliberately sends meta on every assistant node and leaves the choice to the drawer.
- A live `upsert` can in principle change two nodes (a folded result becoming an orphan, or an orphan folding away when its call lands), and `projectUpsert` returns one; no server path was found that emits either sequence, so this is a documented limit and not a defect.

Done when each item is either added to the contract and projection with a structural test, or recorded as declined in the `protocol.ts` docblock, and this card's close note says which went which way.
