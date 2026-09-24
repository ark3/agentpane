---
labels: [question]
---

# Codex 0.156.0 added a functionCallOutput thread item that the mapper flags as an unknown type

Found 2026-09-24 while executing OW-riluye, which regenerated `resources/codex-protocol/` from `codex-cli 0.156.0`.
`resources/codex-protocol/v2/ThreadItem.ts` now carries a variant `{ "type": "functionCallOutput", id, name, namespace, output: FunctionCallOutputBody }` that the bindings vendored on 2026-08-10 did not.
`src/server/adapters/codex/mapping.ts` has no case for it, so it reaches the switch's `default` arm ("unknown item type: ${type}") and comes back with `unknownType: true`; the docblock on that field, near "`unknownType` is the load-bearing half", says what that flag sets off downstream.
The type check does not catch this, because the `default` arm accepts any variant.

Nobody has seen one of these items arrive yet, and nobody has decided what it should render as.
The question is whether a live 0.156.0 session emits `functionCallOutput` over the wire, and when, and whether agentpane should draw it — as a tool result, the way `mcpToolCall` and `dynamicToolCall` draw theirs in the same file — or list it in `SILENT_ITEM_TYPES`, beside `subAgentActivity`, whose comment is the model for recording why.
Drive Codex with `codex -m gpt-5.6-luna`, per AGENTS.md "Evidence", and record the run in `docs/MANUAL_TESTING.md`.

Done when `functionCallOutput` has its own handling in `mapping.ts`, rendered or listed as silent with the reason and the codex-cli version beside it, and a test in `src/server/adapters/codex/reducer.test.ts` fails without that handling and passes with it.
