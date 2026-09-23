---
labels: [change, emacs-native, now]
closed: done
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
- Tool-result image parts: `resultImages` in `src/client/render/types.ts`, drawn by `src/client/render/tools/ResultBody.svelte`; the contract says explicitly they are not carried.
  Drawn at least as the user's own `image` parts are today, the `[image <mime>]` line in `agentpane--insert-part`.
- The browser's `showsMeta` suppression in `Message.svelte` hides meta for a pending turn or one with no model and zero tokens; the contract deliberately sends meta on every assistant node and leaves the choice to the drawer, so this one is the drawer applying `showsMeta`'s rule in `agentpane--insert-meta`, not a contract change.
  Amended 2026-09-23: a node does not say it is pending — the `protocol.ts` docblock's Meta list says a streaming turn "is recognised by the projection still re-sending the node, not by anything in it" — so the drawer derives pending from the buffer's streaming state and the node being the last, and the line must appear once streaming ends.

## Done when

Each of the three facts is in the `protocol.ts` docblock and the projection in `src/emacs/nodes.ts`, with a structural test in `src/emacs/nodes.test.ts` red before the change.
Each is drawn in `emacs/agentpane.el`, and the `showsMeta` rule applied, with `ert` tests in `emacs/agentpane-test.el` red before the change, that file green as its Commentary says and the pass count in `emacs/agentpane.el`'s Commentary updated.
`bun run check` passes.

## Close note

Landed as 9050cbe (contract and projection) and a000b72 (drawing) on main.
Contract, in the `src/emacs/protocol.ts` docblock and types: `timestamp` (epoch ms as the message holds it) on user and assistant nodes and on a `tool` part once its result arrived, omitted when not finite because a preview turn with no recorded time arrives as `NaN` (`previewMessages` in `src/client/preview.ts`); `tokensBefore` on every `compactionSummary` node, 0 when unreported; `images` on a `tool` part as ordinary `image` parts, present only when the result has any.
Drawing in `emacs/agentpane.el`: the assistant meta line leads with the time in `formatTimestamp`'s shape in Emacs's zone; the user turn's time is the last line inside its box, in the meta face (first cut; the browser puts it on the first block's action row); the compaction header gains `· from 28K tok`; result images are `[image <mime>]` lines after the result text inside the fold.
The tool part's timestamp is carried and not drawn: OW-gageru draws it.
`showsMeta` is applied drawer-side, with no contract flag: the meta facts are hidden while the node is the streaming tail (`agentpane--tail-index` with `agentpane--streaming`) or when there is neither model nor tokens, while `stopReason`/`errorMessage` still draw.
The streaming-off status redraws the last node, and appending a node while streaming redraws the one before.
That differs from the browser for Claude Code only: the browser keys on `stopReason === "pending"`, which Pi and Codex set, so a live Claude turn shows its meta there and not in Emacs.
Verified: new structural tests in `src/emacs/nodes.test.ts` and eight new ert tests, each shown red before; ert 54 of 54 with the Commentary count updated, time tests pinned to Asia/Kolkata with `set-time-zone-rule` and also green under UTC and Pacific/Auckland; `bun run check` green (1184 tests).
Filed from what surfaced: OW-nawela (a tool left `running` after the turn ends) and OW-yaboke (the compaction marker's raw role name).
