---
kind: change
where: '`src/server/adapters/codex/mapping.ts` (`compactionMarker`, `MapContext`), `src/server/adapters/codex/reducer.ts` (`tokenUsage`, `:85`/`:358`)'
---

# Codex's compaction marker shows no token figure, and the usage payload that could supply one is already in the reducer, unread.

OW-72 built one compaction renderer for both backends: `Message.svelte` draws
the marker always, and the summary text and token figure only when present.
Pi's marker gets both, synthesised by the reducer from `compaction_end`
(`MANUAL_TESTING.md:378` records `tokensBefore 17660` from the live run).
Codex's gets neither: `mapping.ts:474-483` maps `contextCompaction` to
`compactionMarker` (`:505-508`), which is `{summary: "", tokensBefore: 0}`.

The empty summary is correct and settled -- the item is `{type, id}` and
carries no text, and OW-72's close note says not to go hunting for one. The
**token figure is a different case**, and the comment at `mapping.ts:478-481`
says why: `tokensBefore` "is unknown here (it rides `thread/tokenUsage/
updated`, not the item)". That payload is not unavailable; it is sitting in
`CodexReducer.tokenUsage` (`reducer.ts:85`, assigned `:358`), and nothing in
`src/` outside the reducer reads it. `MapContext` carries only `{timestamp,
completed, ...identity}`, so `mapItem` cannot see it. That seam is the work.

## Two things the obvious implementation gets wrong

Both are readable from the committed capture,
`resources/fixtures/codex/compact.jsonl`; check them there before writing code.

**The figure is already stale by the time the item is mapped.** The capture's
event order around the compaction is `item/started contextCompaction`, then
*three* `thread/tokenUsage/updated`, then `item/completed contextCompaction`.
`applyItem` maps the completed item, so `this.tokenUsage` has been overwritten
twice by then and holds `last.totalTokens: 4844` -- the **post**-compaction
figure. Plumbing the field through as-is labels the after number "before". The
value to capture is the one live at `item/started`.

**`total` is cumulative for the thread, not a context size.** Across the same
capture `total.totalTokens` runs 9398 -> 23009 -> 37756 -> 54060 -> 68752,
climbing straight through the compaction. It is a running sum of every request
and must not be used. The candidate is `last.totalTokens` at `item/started`,
which is 16304 in this capture.

## The thing to settle before choosing a field

`MANUAL_TESTING.md:368` quotes the live Codex run as 16802 -> 9231, which
matches **neither** field in this capture -- so either the prose figure came
from a different measurement than the one a reader would reconstruct, or the
mapping from payload to "context before" is not what it looks like. Reconcile
that first. Pi's marker will be showing `tokensBefore` from `compaction_end`
(17660) in the same list, so two markers on one screen must mean the same
thing by the same name; picking a Codex field that measures something else is
worse than the blank the code shows today.

## Done when

- A reducer test drives the committed Codex compaction fixture and asserts the
  emitted `compactionSummary` carries the **pre**-compaction figure, not the
  post-compaction one. That distinction is the whole point, so assert the
  specific number the fixture supports rather than "greater than zero".
- A render test asserts a Codex compaction marker displays a token figure,
  alongside the existing assertion that it is not the fallback card.
- Both watched red first.
- `MANUAL_TESTING.md` gains a line reconciling its 16802 -> 9231 figures with
  the field finally chosen, or is corrected.
- `bun run check` passes.

Load-bearing: the figure means the same thing on both backends, and it is the
one live before compaction. Incidental: how `MapContext` grows to carry it, and
where the figure sits in the marker.
