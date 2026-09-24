---
labels: [change]
---

# The vendored Codex protocol bindings in resources/codex-protocol are behind the installed codex-cli

Noticed 2026-09-23 by OW-hojefo's implementer, who regenerated the bindings from `codex-cli 0.156.0` with `codex app-server generate-ts` to check `thread/fork`'s options and found `ThreadForkParams` there carrying an `excludeTurns` field that `resources/codex-protocol/v2/ThreadForkParams.ts` lacks.
Nothing in agentpane used that field then, and OW-hojefo measured that no `thread/fork` form keeps no turn.

It now blocks work.
On 2026-09-24 a Codex session showed the notice OW-tujiya surfaces: "Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`."
Moving agentpane onto that API is the card blocked by this one, and none of it is in the vendored bindings: bindings generated from `codex-cli 0.156.0` into a scratch directory that day carried `v2/ThreadTurnsListParams.ts`, `v2/ThreadItemsListParams.ts`, `v2/ThreadHistoryMode.ts` (`"legacy" | "paginated"`), `Thread.historyMode`, `excludeTurns` on `ThreadResumeParams` and `ThreadForkParams`, and the `turnsBackwardsCursor` and `itemsBackwardsCursor` fields on `ThreadResumeResponse`, none of which `resources/codex-protocol/` has.
Regenerating may change types agentpane already imports; making `bun run check` pass again after the regeneration is part of this card, and any change in behaviour it forces is named in the commit.

Done when `resources/codex-protocol/` is regenerated from the installed `codex-cli` with `codex app-server generate-ts`, carries the types named above, its version is recorded wherever the directory records its source (check its README or the commit that vendored it), and `bun run check` passes.
