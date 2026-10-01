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

## Amended 2026-09-30 by OW-zadupu

Measured on the home server on `codex-cli 0.157.1` with `gpt-5.6-luna`: `resources/fixtures/codex/collab-failed.rollout.jsonl` and `collab-multi.rollout.jsonl`, each beside the stream of the same run; `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)".
On that version the mechanism above no longer fires: no collab rollout holds a `function_call` at all, and a spawn or wait is a `custom_tool_call` named `exec` whose script calls `tools.multi_agent_v1__spawn_agent` or `tools.multi_agent_v1__wait_agent`, which the preview draws as `exec`.
The spawn prompt is plain text in that script (`message: "Reply with exactly one word: Hello."`), not encrypted, so the bound "the prompt is not readable from the rollout" holds only for the 2026-08-28 rollout's version.
The child's reply is recoverable on disk three ways: the wait script's output, the `<subagent_notification>` user-role message Codex writes when a child finishes (which the preview draws as a user turn, OW-mehezu), and the collab call's `item_completed` record.
`src/server/sessions/codex-conformance.test.ts` lists the naming disagreement in `KNOWN_DIFFERENCES` under this card.
Rollouts written by older versions still carry the `collaboration__spawn_agent` form, so a parity decision has two stored shapes to answer for.

## Amended 2026-09-30 under OW-luvema

OW-luvema, filed 2026-09-30, has the preview build items from the rollout's `item_completed` records through live `mapItem` wherever a rollout carries them; a `CollabAgentToolCall` record carries `tool`, `prompt`, `receiver_agents` and `agents_states`, so a spawn previews as the live `subagent` card, and its done-condition removes this card's `KNOWN_DIFFERENCES` entries.
What remains here afterwards is the link to the child thread, which is presentation and may belong with OW-novuye and OW-gakide, and the older `collaboration__spawn_agent` rollouts that carry no item records, whose differences OW-luvema accepts as a first cut.
