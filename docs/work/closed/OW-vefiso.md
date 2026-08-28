---
labels: [defect]
---

# `collabAgentToolCall` is a known `ThreadItem` variant that lands in the unknown bucket, and the switch's docblock counts 17 variants where the bindings now carry 18.

`src/server/adapters/codex/mapping.ts` (`SILENT_ITEM_TYPES` `:286-292`, the `mapItem` docblock `:294-299`, the `default` arm `:485-490`)

`ThreadItem` has 18 variants (counted from
`resources/codex-protocol/v2/ThreadItem.ts`, 2026-08-19). `mapItem` maps 12,
`SILENT_ITEM_TYPES` deliberately swallows 5, and that leaves exactly one
unaccounted for: `collabAgentToolCall`. It reaches the `default` arm and is
reported as `unknown item type: collabAgentToolCall`, which is the string for a
variant Codex added after this code was written -- not for one sitting in the
bindings the repo already vendors.

Nothing breaks. The `default` arm returning `kind: "none"` is the design
working as intended (`:294-299`: a reducer that threw "would take the session
down on a routine `codex` upgrade"). The defect is that the item is
**unclassified**, so the one signal distinguishing "Codex moved" from "we never
decided" is spent on a case where we simply never decided.

## Which way to classify it

The variant carries `id`, `tool` (`CollabAgentTool`), `status`
(`CollabAgentToolCallStatus`) and the issuing agent's thread id -- the shape
`toolPair` already handles, and closer to `dynamicToolCall` (mapped) than to
`subAgentActivity` (silent). So mapping it is plausible on shape alone.

Against that: **no capture exists**, and producing one needs a Codex collab
session, which nothing in `resources/probes/capture_fixtures.py` currently
drives. This repo's rule is not to hand-write a wire shape nobody has seen
(OW-72 made a capture rather than guess), and a tool card rendered from a
guessed shape is worse than no card.

So the cheap correct move is to add it to `SILENT_ITEM_TYPES` with a comment
saying *why* it is silent -- unrendered for want of a capture, not by design --
which turns a lying diagnostic into an accurate one and leaves the door open.
Choosing to map it instead is fine, but then it owes a captured fixture.

## Done when

- `collabAgentToolCall` no longer reaches the `default` arm.
- A reducer test asserts the chosen classification: if silent, that the item
  reduces to no message **and** reports `unrendered` rather than `unknown`;
  if mapped, an assertion driven by a committed fixture. Watched red first.
- The `:296` docblock says 18, or stops naming a number -- a count that must be
  re-synced on every `codex` upgrade is the same defect as the one OW-32
  describes in DESIGN's table, one file over.
- `bun run check` passes.

**Fixed** in a16a0b9: `collabAgentToolCall` joins `SILENT_ITEM_TYPES` with a
comment recording that it is silent for want of a capture rather than by
design, so the `default` arm now answers `unrendered item type:
collabAgentToolCall` and `unknown` goes back to meaning *Codex moved*. The
`mapItem` docblock stops naming a variant count instead of bumping 17 to 18 --
a number re-synced on every `codex` upgrade drifts again. Pinned by
`reducer.test.ts`'s "classifies collabAgentToolCall as unrendered rather than
unknown", watched red against the pre-fix `mapping.ts` (`- "unrendered item
type: collabAgentToolCall"` / `+ "unknown item type: collabAgentToolCall"`).
Mapping it to a tool card was declined for the reason above: no capture exists.

One thing the fix does not reach, and that this item did not claim it would:
nothing in `src/` reads either `MappedItem.reason` or the reducer's
`unmappedItemTypes`, and `remap` (`reducer.ts:293`) adds every `kind: "none"`
type to that set regardless of which reason it carried. So the accurate string
is currently only visible to a test. The registry is now honest, which is what
was asked; surfacing it is not filed.
