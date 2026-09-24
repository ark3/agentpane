---
labels: [change]
closed: done
---

# The vendored Codex protocol bindings in resources/codex-protocol are behind the installed codex-cli

Noticed 2026-09-23 by OW-hojefo's implementer, who regenerated the bindings from `codex-cli 0.156.0` with `codex app-server generate-ts` to check `thread/fork`'s options and found `ThreadForkParams` there carrying an `excludeTurns` field that `resources/codex-protocol/v2/ThreadForkParams.ts` lacks.
Nothing in agentpane used that field then, and OW-hojefo measured that no `thread/fork` form keeps no turn.

It now blocks work.
On 2026-09-24 a Codex session showed the notice OW-tujiya surfaces: "Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`."
Moving agentpane onto that API is the card blocked by this one, and none of it is in the vendored bindings: bindings generated from `codex-cli 0.156.0` into a scratch directory that day carried `v2/ThreadTurnsListParams.ts`, `v2/ThreadItemsListParams.ts`, `Thread.historyMode` (typed by `v2/ThreadHistoryMode.ts`, `"legacy" | "paginated"`, which the vendored copy already has), `excludeTurns` on `ThreadResumeParams` and `ThreadForkParams`, and the `turnsBackwardsCursor` and `itemsBackwardsCursor` fields on `ThreadResumeResponse`, none of which `resources/codex-protocol/` has.
Regenerating may change types agentpane already imports; making `bun run check` pass again after the regeneration is part of this card, and any change in behaviour it forces is named in the commit.

Done when `resources/codex-protocol/` is regenerated from the installed `codex-cli` with `codex app-server generate-ts`, carries the types named above, its source version is recorded, and `bun run check` passes.
Amended 2026-09-24 at execution: the directory has no README and its vendoring commit (c3ea4c1) names no version, so nothing recorded one; the one place that describes the directory is fact 5 in `docs/HANDOFF.md` ("642 files, 550 of them under `v2/`"), and the `src/server/adapters/codex/protocol.ts` docblock repeats the 642 count, so the version goes into fact 5 and both counts are brought current.

## Close note

Done 2026-09-24 in 42e20af.
`resources/codex-protocol/` was replaced wholesale by the output of `codex app-server generate-ts --out <dir>` from `codex-cli 0.156.0`, with neither `--experimental` nor `--prettier`.
Generated that way, 566 of the 642 old files come out byte-identical, so the diff holds only protocol changes.
The result is 726 files, 631 of them under `v2/`: 86 added, 74 changed, and 2 removed (`thread/rollback`'s params and response, gone from 0.156.0).
Every type the card named is present, and none is adopted yet.
The version and the new counts are recorded in fact 5 of `docs/HANDOFF.md`, and the `protocol.ts` docblock count is brought current.
One runtime change was forced: `UserInput`'s `image` variant can now carry `fileId` instead of `url`, and `mapping.ts` degrades a `fileId` image to `[image: <fileId>]`, the way it handles `localImage`.
A new test in `reducer.test.ts` covers that; it fails against the old line and passes with the fix.
Test fixtures gained the newly required fields, all set to null.
`bun run check` passes, with 1329 tests.
Filed OW-vevizo for the new `functionCallOutput` item, which the mapper flags as an unknown type.
