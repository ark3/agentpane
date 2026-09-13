---
labels: [change]
closed: done
---

# Codex's compaction marker shows no token figure, and the usage payload that could supply one is already in the reducer, unread.

`src/server/adapters/codex/mapping.ts` (`compactionMarker`, `MapContext`), `src/server/adapters/codex/reducer.ts` (`tokenUsage`, `applyTokenUsage`)

OW-72 built one compaction renderer for both backends: `Message.svelte` draws
the marker always, and the summary text and token figure only when present.
Pi's marker gets both, synthesised by the reducer from `compaction_end`
(`MANUAL_TESTING.md`'s "Observed manual compaction" section records `tokensBefore 17660` from the live run).
Codex's gets neither: `mapping.ts`'s `contextCompaction` arm maps to
`compactionMarker`, which is `{summary: "", tokensBefore: 0}`.

The empty summary is correct and settled -- the item is `{type, id}` and
carries no text, and OW-72's close note says not to go hunting for one. The
**token figure is a different case**, and the comment in that arm
says why: `tokensBefore` "is unknown here (it rides `thread/tokenUsage/
updated`, not the item)". That payload is not unavailable; it is sitting in
`CodexReducer.tokenUsage` (`reducer.ts`, assigned in `applyTokenUsage`), and nothing in
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

## The thing to settle before choosing a field — settled 2026-09-13

`MANUAL_TESTING.md`'s "Observed manual compaction" section quotes the live Codex run as 16802 -> 9231, which
matches **neither** field in this capture -- so either the prose figure came
from a different measurement than the one a reader would reconstruct, or the
mapping from payload to "context before" is not what it looks like. Reconcile
that first. Pi's marker will be showing `tokensBefore` from `compaction_end`
(17660) in the same list, so two markers on one screen must mean the same
thing by the same name; picking a Codex field that measures something else is
worse than the blank the code shows today.

**Settled by the executing session, 2026-09-13, from the committed capture.**
The 16802 -> 9231 pair cannot be reconstructed from
`resources/fixtures/codex/compact.jsonl` by any field: across the compaction
`total.totalTokens` runs 54060 -> 68752 and `last.totalTokens` runs
16304 -> 14692 -> 4844, and the strings "16802" and "9231" appear nowhere in
the capture. The prose therefore came from a different run than the one that
was committed, and the surrounding claim that "the token figures below are
read straight from them, not estimated" is false for the Codex pair. The field
to use is `last.totalTokens` live at `item/started contextCompaction` -- 16304
here -- which is the last model request's input+output, i.e. the context as it
stood going into the compaction, the same thing Pi's `tokensBefore` names.
Correcting the prose is part of this card, and there are **two** copies of the
16802 -> 9231 claim: `docs/MANUAL_TESTING.md` and `resources/fixtures/README.md`
(the "Codex (`compact.jsonl`, 5247 lines)" bullet). `docs/work/closed/OW-72.md`
carries a third; leave that one, a closed card is a record of what was believed
then.

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

## Close note

Codex's compaction marker now carries a real pre-compaction token figure, on `main` at 459c05c ("feat: Codex's compaction marker carries the pre-compaction token figure").

**The field, and why.** `last.totalTokens` sampled at `item/started contextCompaction` -- the last model request's input+output, i.e. the context as it stood going in, which is the same quantity Pi's `tokensBefore` names. In the committed capture that is 16304. `total.totalTokens` was rejected: it is cumulative for the thread and runs 9398 -> 23009 -> 37756 -> 54060 -> 68752, climbing straight through the compaction.

**The card's open question, answered.** `MANUAL_TESTING.md` and `resources/fixtures/README.md` both quoted the Codex drop as 16802 -> 9231, under a claim that the figures were "read straight from" the committed capture. They are not: no field reconstructs that pair, and the strings appear nowhere in `resources/fixtures/codex/compact.jsonl`. The pair came from a different run of the same probe. Both copies are corrected in the same commit and now carry the numbers the capture actually supports, with `codex-cli 0.147.0` named. The third copy, in closed OW-72, was deliberately left as a record of what was believed then.

**The seam.** `CodexReducer` gained a private `compactionTokensBefore: Map<itemId, number>`, written in the `item/started` branch that already special-cased `contextCompaction`, cleared in `reset()`, read in `remap()` into a new `MapContext.tokensBefore`. Keyed by item id rather than held as one field so a hydrated compaction -- which never sees an `item/started` -- reports 0 instead of borrowing a neighbour's figure. Sampling at start is the whole trick: three `thread/tokenUsage/updated` fire between the item's start and its completion, so the naive read at mapping time yields the *post*-compaction 4844.

**How it was verified.** Two tests, and the dispatching session confirmed the red itself rather than taking the implementer's word. `src/server/adapters/codex/reducer.test.ts` drives the whole committed fixture and asserts the exact 16304; `src/client/render/Transcript.svelte.test.ts` drives a real `CodexReducer` over the capture's event order and asserts the rendered `.compaction-tokens`. Defeating the fix two ways made both go red and nothing else: passing 0 through gave `tokensBefore: 0`, and reading `this.tokenUsage` at mapping time gave `tokensBefore: 4844` -- the precise bug the card was written about. `bun run check` passes clean, 49 files / 1059 tests / 39s.

**One thing deliberately unchanged.** The existing `reducer.test.ts` case asserting `tokensBefore: 0` did not flip and should not have: its helper sends only `item/completed`, so no start and no usage were ever observed and 0 is the honest answer. Its comment now says that rather than leaving it reading as a leftover. Same for the OW-72 "bare marker" render test, which stays reachable via cold hydrate.

**Filed, not fixed:** OW-bisubi -- the session-preview path (`src/server/sessions/codex.ts`) reconstructs compaction markers from the on-disk rollout and still hardcodes `tokensBefore: 0`, so the same compaction now shows a figure in the transcript and none in the session list.

**For anyone loading fixtures from a jsdom test:** you cannot. `readFixture` in the server test-support module dies with "The URL must be of scheme file" when pulled into the client project, because Vite rewrites `import.meta.url` there. Model the event order by hand instead, which is what the render test does.
