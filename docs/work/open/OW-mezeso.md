---
labels: [defect]
---

# `unmappedItemTypes` collects every item that produced no message, so it holds `reasoning` in every ordinary session and the silent/unknown distinction beside it is computed and thrown away.

`src/server/adapters/codex/reducer.ts` (`unmappedItemTypes` `:93`, `remap` `:293`), against `src/server/adapters/codex/mapping.ts` (`MappedItem.reason` `:61`)

`mapItem` returns `{ kind: "none", reason }` with three distinct reasons:
`unknown item type: <t>` for a variant nobody has taught it about,
`unrendered item type: <t>` for one in `SILENT_ITEM_TYPES` (OW-vefiso), and
`empty reasoning` for a hidden reasoning item. `remap` discards all three:

```
if (mapped.kind === "none") {
	this.unmappedItemTypes.add(slot.item.type);
```

So the set is not "item types we could not map". It is "item types that at
least once produced no message", which is a different claim, and the reasoning
arm's comment says every fixture emits hidden reasoning -- meaning `"reasoning"`
lands in `unmappedItemTypes` in essentially every session, alongside the five
deliberately silent types. A genuinely unknown type is one entry among several
that are all working exactly as designed.

Two things follow, and the second is why this is worth a file rather than a
comment. `MappedItem.reason` has no reader at all: `rg 'mapItem\(|\.reason\b'
src --glob '!*.test.ts'` returns the definition and the one call site, nothing
else. `unmappedItemTypes` has no reader outside one assertion in
`reducer.test.ts`. So the accuracy OW-vefiso bought -- `unknown` meaning *Codex
moved* and nothing else -- is currently observable only from a test, and the
one field that carries it is dropped one line after it is produced.

## What is undecided

Whether the distinction should reach anyone, and if so who. Nothing today logs
it, ships it to the client, or fails a build on it, and this repo does not add
telemetry nobody asked for. The narrow correct fix is smaller than that: keep
the set faithful to its name, so that whatever later reads it reads something
true. Either drop the `empty reasoning` and `unrendered` cases from it, or
split it by reason.

Do not resolve this by renaming the set to match what it collects. That keeps
the bad half -- a genuinely unknown type would still be indistinguishable from
a deliberately silent one -- and spends the rename on the symptom.

## Done when

- A `kind: "none"` carrying `empty reasoning` or `unrendered` no longer makes
  its type indistinguishable from a genuinely unknown one, by whichever of the
  two routes above is chosen.
- A reducer test drives a fixture with hidden reasoning and asserts
  `"reasoning"` is not reported as unmapped, plus the existing
  `quantumEntanglement` assertion still holding. Watched red first -- it goes
  red against today's `remap` without any change to the fixture.
- `bun run check` passes.

Filed from OW-vefiso's close, which found it and did not fix it.
