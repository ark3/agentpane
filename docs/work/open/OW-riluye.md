---
labels: [deferral]
---

# The vendored Codex protocol bindings in resources/codex-protocol are behind the installed codex-cli

Noticed 2026-09-23 by OW-hojefo's implementer, who regenerated the bindings from `codex-cli 0.156.0` with `codex app-server generate-ts` to check `thread/fork`'s options and found `ThreadForkParams` there carrying an `excludeTurns` field that `resources/codex-protocol/v2/ThreadForkParams.ts` lacks.
Nothing in agentpane uses that field, and OW-hojefo measured that no `thread/fork` form keeps no turn, so this blocks nothing; it matters to whoever next reads the vendored bindings as the protocol's current shape.

Done when `resources/codex-protocol/` is regenerated from the installed `codex-cli`, its version recorded wherever the directory records its source (check its README or the commit that vendored it), and `bun run check` passes; or when the owner decides the bindings are pinned deliberately and that is written beside them.
