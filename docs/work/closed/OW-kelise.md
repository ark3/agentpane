---
labels: [defect]
closed: done
---

# A stored Codex rollout previewed from the picker draws the subagent card with no link to the child thread, and one from 0.150.1 through 0.154.0 still draws an opaque collaboration__spawn_agent card

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

## Amended 2026-10-01 after OW-luvema closed

OW-luvema landed the naming half for every rollout whose `item_completed` records are a full copy, 0.157.1's among them: the preview draws a collab call through live `mapItem` as the `subagent` card, with the child's id, and `codex-conformance.test.ts` holds no entry for this card, which was red until it did.
`docs/DESIGN.md` beside D19 now records that, at "since OW-luvema the preview draws it through `mapItem` like the live item".
Rollouts from 0.150.1 through 0.154.0 that store collab calls as `collaboration`-namespace function calls take the preview's fallback instead, because their records are not a full copy (no record for a spawn, an empty one for every wait; counts in `extractStoreTurn`'s docblock in `src/server/sessions/codex.ts`), so they keep the opaque default card; OW-luvema accepted that as a first cut.

What remains here is the decision this card's first done-condition asked for, narrowed to the link: whether the read-only preview's subagent card should offer Open thread, which today it cannot, because the `{#if previewing}` branch of `src/client/App.svelte` renders `<Transcript>` with no `onopensession`.
Per `AGENTS.md`, "Both clients", a yes lands in agentpane-mode too, where OW-gakide carries the live link and OW-novuye the node contract it needs.
Done when that decision is recorded beside D19 in `docs/DESIGN.md`, together with a sentence on whether the 0.150.1–0.154.0 default card is left as it is; where the decision is yes, a client test renders the preview's subagent card with the control, watched red first.

## Close note

Decided with the owner on 2026-10-01 and recorded beside D19 in `docs/DESIGN.md`: the read-only preview's subagent card offers Open thread in both clients, and the opaque default card for 0.150.1–0.154.0 rollouts stays as it is (encrypted arguments, no spawn record, so no child to link).
Browser half: the `{#if previewing}` branch of `src/client/App.svelte` passes `onopensession={openSession}`. Open thread calls `controller.preview`, as a picker row click does, so it never attaches. Pinned by "opens the child thread from a preview's subagent card too (OW-kelise)" in `src/client/App.test.ts`, red on the old code because the control was absent. `bun run check` is green on main.
The adversarial read found that the comments' "another preview" overclaimed, since a child already attached in this client goes to its live transcript, and those comments were corrected. Its other checks came out clean: selection-intent races, preview polling, `gone`, a child equal to the current preview, and scroll keys all behave as for a row click.
Emacs half: OW-gakide was amended to cover preview buffers and to test from both.
