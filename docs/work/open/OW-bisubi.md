---
labels: [defect]
---

# Codex session previews still draw a compaction marker with no token figure, unlike the live transcript

`src/server/sessions/codex.ts`, the `if (payload.type === "context_compaction" || payload.type === "compaction")` arm, which returns a `SessionPreviewTurn` with `tokensBefore: 0` hardcoded.

OW-kelomi gave Codex's *live* compaction marker a real pre-compaction figure: the reducer samples `last.totalTokens` at `item/started contextCompaction` and hands it to `mapItem` on `MapContext.tokensBefore`.
The session-*preview* path is a separate reconstruction -- it reads the on-disk rollout rather than the live app-server stream -- and was not touched, so the same compaction now renders with a figure in the transcript and without one in the session list.
That inconsistency is the defect; a reader who sees both surfaces has no way to know they are the same event.

Noticed by OW-kelomi's implementer and deliberately left: its card named the live stream only.

## What nobody has checked

Whether the rollout on disk carries a usable usage entry at all, and if so whether one sits near enough to the compaction record to mean "context before".
That is the first question, and it may answer the card by itself: if the rollout has no such entry, the honest outcome is a comment at that arm saying so, not a figure.
Do not reach for `total` if you find one -- it is cumulative for the thread and climbs straight through a compaction; OW-kelomi has the numbers.

A rollout to read is whatever `resources/probes/capture_fixtures.py --scenario compact` leaves behind, or any `~/.codex` rollout containing a compaction; the committed `resources/fixtures/codex/compact.jsonl` is the app-server *stream*, not the rollout, so it cannot answer this.

## Done when

Either a preview test drives a rollout containing a compaction and asserts a specific non-zero `tokensBefore` that means the same thing the live marker's does -- watched red first -- or the arm carries a comment naming the rollout field that was looked for, the version it was looked for on, and what was there instead.
`bun run check` passes either way.

Load-bearing: the figure means the same thing wherever it appears, which is why OW-kelomi refused a field that measured something else.
Incidental: whether the preview shows a figure at all, if the data turns out not to be there.
