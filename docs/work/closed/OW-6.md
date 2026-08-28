---
labels: [deferral]
---

# `contextCompaction` is dropped, because the generated item carries no summary.

Codex reducer

DESIGN's wording says otherwise; one of the two has to change.

**Closed on 2026-08-19: already answered, by OW-72 in `e22740d`.** The premise
above -- that `contextCompaction` is dropped -- stopped being true when manual
compaction landed. `mapping.ts:474-483` maps the item to `compactionMarker`
(`:505-508`), a `compactionSummary` with an empty summary, and
`Message.svelte`'s single compaction renderer draws it as a bare divider;
Pi's equivalent, synthesised from `compaction_end`, draws with text and a
token figure through the same component. Live captures for both backends are
committed at `resources/fixtures/{codex,pi}/compact.jsonl`, and
`MANUAL_TESTING.md:357` records the measured context drop.

So "one of the two has to change" resolved in favour of the code, and DESIGN
was never wrong about the outcome -- only about the evidence. Its remaining
defect is that `DESIGN.md:653` still lists `contextCompaction` among the rows
with "no capture yet". That correction is **OW-32's**, which already owns the
same table being wrong in two other ways; it is not left undone here.

The asymmetry worth not re-deriving: Codex's item is `{type, id}` and can only
ever produce a bare marker, while Pi's carries a summary. One renderer, two
appearances, by design. OW-kelomi is open on whether the Codex marker should
at least carry a token figure.
