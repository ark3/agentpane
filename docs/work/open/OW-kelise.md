---
labels: [defect]
---

# A stored Codex rollout previewed from the picker still shows a subagent spawn as an opaque collaboration__spawn_agent card with an encrypted argument and no link to the child thread.

`src/server/sessions/codex.ts` (`extractCodexPreviewTurns`, the `function_call || custom_tool_call` branch that builds the name), `src/client/App.svelte` (the `{#if previewing}` branch that renders `<Transcript>` without `onopensession`), `src/client/render/tools/SubagentTool.svelte` and `src/client/render/tools/registry.ts`.

OW-benige gave the **live attached** transcript an honest subagent block: `collabAgentToolCall` maps to a tool pair named `subagent`, and the card names the child thread and offers to open it.
Open the same parent session read-only from the picker and none of that happens.

## Mechanism, read from the code

The live path and the preview path build their tool calls from different sources and name them differently.
Live, the name comes from `CODEX_TOOL_NAMES.collabAgentToolCall`, which is `subagent`, and `registry.ts` has a renderer for it.
Preview reads the rollout on disk, where the same operation is stored as a Responses-API item, and `extractCodexPreviewTurns` names it `` `${namespace}__${name}` `` — so it arrives as `collaboration__spawn_agent` and resolves to `DefaultTool`.

Observed in a real rollout on the home server (2026-09-11, `~/.codex/sessions/2026/08/28/`): the stored item is `{"type":"function_call","name":"spawn_agent","namespace":"collaboration",...}` and its `arguments.message` is an encrypted blob beginning `gAAAAAB`, so even the default card has nothing legible to show.

The preview `<Transcript>` also passes no `onopensession`, so even if the name matched there would be no control to draw.
That second half is deliberate today and cheap to change; the naming mismatch is the substance.

## What is undecided

Whether the preview should reach parity at all is the first question.
Parity would mean either teaching `extractCodexPreviewTurns` to emit the `subagent` name for `collaboration__*` calls, or registering the stored names alongside it.
The encrypted `arguments.message` bounds what parity can be worth: the prompt is not readable from the rollout, so a preview card could name the operation and the child thread but not what was asked, and whether the child's reply is recoverable from the rollout at all is unmeasured.
Measure that before choosing, because it decides whether parity buys a real card or a slightly better stub.

## Done when

- A decision is recorded in `docs/DESIGN.md` beside D19 saying whether the preview path reaches parity, with the measurement of what a preview card could actually show behind it.
- If parity is chosen, a preview of a stored parent rollout renders the subagent card and a test driven by a committed rollout fixture asserts it, watched red first.
- If parity is declined, D19's statement of the live-only scope is what closes this, and no code changes.
