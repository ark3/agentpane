---
labels: [defect]
---

# The CODEX_TOOL_NAMES docblock says all five collab tools share the name subagent, and the protocol now has nine

`src/server/adapters/codex/mapping.ts`, the docblock on `CODEX_TOOL_NAMES`, in the paragraph beginning "All five collab tools".
It lists `spawnAgent`, `sendInput`, `resumeAgent`, `wait` and `closeAgent`, while `CollabAgentTool` in the vendored `resources/codex-protocol/v2/CollabAgentTool.ts` (the 0.156.0 bindings) also has `sendMessage`, `followupTask`, `interruptAgent` and `listAgents`.
Found by the adversarial read of OW-guyunu on 2026-10-01.

The paragraph's point still holds for every value: they all take the `collabAgentToolCall` arm of `mapItem` and share the name `subagent`, with the operation in `arguments.tool`.
The comment inside that arm, which says the operations other than `spawnAgent` and `wait` take it untested, should say how many that is.

Done when the docblock names the protocol's tools without a count that the next bindings update can falsify, or cites `CollabAgentTool` for the list, and the arm's comment agrees; docs-in-code only, so `bun run check` passing is the whole check.
