---
labels: [change]
blocked-by: [OW-fafeja]
closed: done
---

# Render a Codex subagent as a collapsed tool-style block in the parent transcript that names the child thread and opens it as its own session, instead of showing nothing.

`src/server/adapters/codex/mapping.ts` (`SILENT_ITEM_TYPES`, `mapItem`, `CODEX_TOOL_NAMES`, `toolPair`), `src/client/render/tools/registry.ts` and `DefaultTool.svelte`, `src/server/sessions/codex.ts`, `src/server/sessions/claude.ts` (its docblock on subagent transcripts).

Once OW-fafeja stops the child thread's items from leaking into the parent, the parent transcript shows nothing at all for a subagent: the parent's own turn appears to pause for minutes inside a `wait_agent` call with no trace of why.
This card is the honest replacement.

## What Codex gives the parent

One `ThreadItem` variant reaches the parent over app-server, `collabAgentToolCall`, currently in `SILENT_ITEM_TYPES` (`resources/codex-protocol/v2/ThreadItem.ts`).
`resources/fixtures/codex/subagent.jsonl` (OW-fafeja, `codex-cli 0.153.4`) shows one item for `spawnAgent` and one for `wait`, each started then completed, with `tool` also able to be `sendInput`, `resumeAgent` or `closeAgent`.
The child's thread id is in `receiverThreadIds`, the spawn prompt is in `prompt`, and the `wait` completion carries the child's final message in `agentsStates[childId].message`, so the block can show what the subagent answered without reading the child thread at all.
`subAgentActivity` is the rollout's on-disk form of the same lifecycle and never arrived over the wire in that capture; leave it in `SILENT_ITEM_TYPES` unless a later capture delivers it.
The shape is the `toolPair` one, which OW-vefiso weighed mapping and stopped at only for want of a capture.

The capture OW-fafeja commits is what says which of these actually arrive over app-server and in what order; read that fixture before choosing the mapping.

## Intent

Map the collab items into the tool-call pair the renderer already knows, one block per spawn, sendInput, wait and close, so the parent reads "spawned agent", "waited", "completed" in sequence and collapsed by default like any other tool card, with the child's final message from `agentsStates` as the wait block's result.
The block carries the child's thread id and offers a way to open that thread as its own session, since it is a real thread with its own rollout and `thread/resume` reaches it.
Do not inline the child's conversation as a nested block: a subagent can run many minutes and many tool calls while the parent is blocked in `wait`, so a nested view dominates the parent for the same confusing effect OW-fafeja removes.
Claude Code's adapter already keeps subagent transcripts out of the parent for this reason; the docblock in `src/server/sessions/claude.ts` states it, and this card makes the two backends consistent.

Whether `sessions/codex.ts` should list `thread_source: subagent` rollouts in the session picker at all, or only reach them through the parent's block, is a decision this card has to take and record in `docs/DESIGN.md`.
Listing them makes the picker noisy for a session that spawned five; hiding them makes the block the only door.
The owner has no preference either way (2026-09-09): pick whichever is easiest to implement cleanly, and say in the DESIGN entry that ease decided it.

## Done when

- `collabAgentToolCall` leaves `SILENT_ITEM_TYPES`, and `reducer.test.ts` asserts, driven by `subagent.jsonl`, the sequence of tool-pair messages one spawn-and-wait produces and that the wait result carries the child's message.
- A client render test asserts the block names the child thread and links it; `bun run test:browser` only if the link needs a real navigation that jsdom cannot settle, in which case add the `browser-testing` label.
- The picker decision is recorded in `docs/DESIGN.md` and the code follows it.
- `bun run check` passes.

## Close note

A Codex subagent now shows in the parent transcript as one collapsed tool card per collab operation, on `main` in `faec189..af8b909`.

`collabAgentToolCall` left `SILENT_ITEM_TYPES` and got a `mapItem` arm returning the `toolPair` shape.
All five collab tools share one renderer name, `CODEX_TOOL_NAMES.collabAgentToolCall = "subagent"`, with the operation in `arguments.tool` and the child thread ids in `arguments.threadIds` — empty on a spawn's `item/started`, filled on the completion, which the reducer's re-map picks up.
The result carries the children's messages from `agentsStates`.
`subAgentActivity` stays silent, now with a comment saying why.

Client side: `src/client/render/tools/SubagentTool.svelte`, registered for `subagent`, showing the operation and short child id collapsed, and the prompt, full child id, an "Open thread" control and the child's reply in the body.
`onopensession` was drilled `App → Transcript → Message → Block → ToolCallBlock → renderer` alongside the existing `onedit` chain; `App.openSession` calls `controller.preview(ref)`, the same call the session list makes, so Attach still works from there.

**The picker decision (D19):** subagent rollouts stay listed, and ease decided it — the owner stated no preference on 2026-09-09, and not filtering is what the code already did.
D19 records the noise it accepts: 45 of the 72 September Codex rollouts on the home server carried `thread_source: "subagent"` (2026-09-11, `codex-cli` 0.150.1 through 0.154.0).

**Scope limit worth knowing:** this is the *live attached* transcript's view only.
A stored rollout records the same calls as Responses-API `function_call`s under the `collaboration` namespace, so `extractCodexPreviewTurns` names them `collaboration__wait_agent` and a read-only preview of the same parent still draws an opaque default card with no child link.
D19 states this, and closing it is OW-kelise.

## How it was verified

`bun run check` green on `main`: 49 test files, 1021 tests.

Every new assertion was watched red, by the dispatching session and not only reported:

- Neutering the `collabAgentToolCall` arm in `mapItem` reddens both new `reducer.test.ts` assertions — the OW-fafeja role sequence and "renders each collab item as a tool pair naming the child thread".
- Cutting the `onopensession` pass-through at *each* of the four hops in turn — `App.svelte`, `Transcript.svelte`, `Message.svelte`, `Block.svelte` — reddens the new `App.test.ts` case and nothing else.
  That test exists because adversarial review found the first cut had no coverage above the leaf component: every hop could be deleted with all 1020 tests green.

`bun run test:browser` was not needed — the control is a button calling `controller.preview`, not a navigation, so jsdom settles it — and was not run.
Nothing under `public/`, `.conversation`, the composer or the message footers was touched.

## What adversarial review changed

Eleven findings were fixed on the branch before landing.
Beyond the test gap above: the registry key is now tied to `CODEX_TOOL_NAMES` (renaming the constant alone would have dropped every card to `DefaultTool` silently); `arguments.model` was removed as dead payload that also changed the arguments' shape between started and completed; a `|| call.name` fallback with no producer was removed; the `{#each}` over `receiverThreadIds` was unkeyed, since the protocol guarantees no uniqueness and a duplicate key throws in Svelte 5 and would take down the whole transcript; `.open-thread` picked up `ap-action` rather than inheriting the full-size global `button` padding; and the mapping arm now records that only `spawnAgent` and `wait` were observed on `codex-cli 0.153.4`, and that `agentsStates` is last-known state rather than this call's output.

Three prose defects were corrected against measurement rather than argument.
The `sessions/codex.ts` docblock claimed a subagent rollout carries `forked_from_id` naming its parent: only 39 of the 45 do, and all six without it were written by 0.154.0, which emits it for 5 of its 11.
D19's picker rationale had argued filtering would be costly machinery; `parseHeader` already reads the `session_meta` payload, so that was a rationalization and was cut in favour of the honest reasons.
D19's enumeration of the stored collab function names listed four of six, omitting `send_message` and `followup_task` — the first and third most common.

## Filed from this work

OW-kelise (defect): the preview-path gap above.
OW-guyunu (deferral): the subagent card's empty-bodied error card on `status: "failed"`, and the unattributed join when several children reply — both shapes no capture has exercised.
