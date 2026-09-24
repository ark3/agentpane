---
labels: [defect]
---

# Codex session preview drops a functionCallOutput record, which carries no call_id

Found 2026-09-24 while executing OW-vevizo, which taught `mapItem` in `src/server/adapters/codex/mapping.ts` to draw Codex's `functionCallOutput` thread item as a tool pair.
That fixed the live wire; the session preview, which reads the rollout file from disk, still drops the same item.

As measured on `codex-cli 0.156.0` (`docs/MANUAL_TESTING.md`, "A Codex turn started with `toolOutput` opens with a `functionCallOutput` item"), the rollout stores it as a `response_item` of `type: "function_call_output"` carrying `id`, `name`, `namespace` (absent when null) and `output`, and no `call_id`.
The preview's reader in `src/server/sessions/codex.ts`, the branch opening `if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")`, returns `null` when `call_id` is not a string, so the record never reaches the preview.
Read from the code, not run.

Even if it passed that guard, the reader would emit a lone `toolResult` with no `toolCall` in front of it, because the preview pairs results with the `function_call` records it saw earlier by `call_id`, and this item has no call before it.
The live mapper draws a synthetic call with empty arguments, named `namespace__name` or `name`; the preview should draw what the live transcript draws, so a session reads the same whether opened live or from disk.

Load-bearing: a `function_call_output` record with an `id` and no `call_id` shows up in the preview as a tool call plus its result, named the way `mapItem`'s `functionCallOutput` case names it, and the ordinary `call_id` path is unchanged.
Incidental: how the preview carries the synthetic call's id.
The item is reached only when a client other than agentpane started a turn with `toolOutput`; agentpane never sends one.

Done when a test beside the existing Codex session-preview tests, fed such a record, goes red on the current reader and green after, and `bun run check` passes.
