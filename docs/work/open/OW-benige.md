---
labels: [change]
blocked-by: [OW-fafeja]
---

# Render a Codex subagent as a collapsed tool-style block in the parent transcript that names the child thread and opens it as its own session, instead of showing nothing.

`src/server/adapters/codex/mapping.ts` (`SILENT_ITEM_TYPES`, `mapItem`, `CODEX_TOOL_NAMES`, `toolPair`), `src/client/render/tools/registry.ts` and `DefaultTool.svelte`, `src/server/sessions/codex.ts`, `src/server/sessions/claude.ts` (its docblock on subagent transcripts).

Once OW-fafeja stops the child thread's items from leaking into the parent, the parent transcript shows nothing at all for a subagent: the parent's own turn appears to pause for minutes inside a `wait_agent` call with no trace of why.
This card is the honest replacement.

## What Codex gives the parent

Two `ThreadItem` variants, both currently in `SILENT_ITEM_TYPES` (`resources/codex-protocol/v2/ThreadItem.ts`):

- `subAgentActivity`: `kind` is `started`, `interacted`, `interrupted` or `completed`, plus `agentThreadId` and `agentPath` like `/root/ow48_implementer`.
  The rollout also carries `completed`, which the vendored `SubAgentActivityKind` does not list; treat the union as open.
- `collabAgentToolCall`: `tool` is one of `spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, with a `status` and the agent's thread id, the shape `toolPair` already handles (OW-vefiso weighed mapping it and stopped only for want of a capture).

The capture OW-fafeja commits is what says which of these actually arrive over app-server and in what order; read that fixture before choosing the mapping.

## Intent

Map the collab items into the tool-call pair the renderer already knows, one block per spawn, sendInput, wait and close, so the parent reads "spawned agent /root/ow48_implementer", "waited", "completed" in sequence and collapsed by default like any other tool card.
The block carries the child's thread id and offers a way to open that thread as its own session, since it is a real thread with its own rollout and `thread/resume` reaches it.
Do not inline the child's conversation as a nested block: a subagent can run many minutes and many tool calls while the parent is blocked in `wait`, so a nested view dominates the parent for the same confusing effect OW-fafeja removes.
Claude Code's adapter already keeps subagent transcripts out of the parent for this reason; the docblock in `src/server/sessions/claude.ts` states it, and this card makes the two backends consistent.

Whether `sessions/codex.ts` should list `thread_source: subagent` rollouts in the session picker at all, or only reach them through the parent's block, is a decision this card has to take and record in `docs/DESIGN.md`.
Listing them makes the picker noisy for a session that spawned five; hiding them makes the block the only door.
The owner has no preference either way (2026-09-09): pick whichever is easiest to implement cleanly, and say in the DESIGN entry that ease decided it.

## Done when

- `subAgentActivity` and `collabAgentToolCall` leave `SILENT_ITEM_TYPES`, and `reducer.test.ts` asserts, driven by the OW-fafeja fixture, the sequence of tool-pair messages one spawn-and-wait produces.
- A client render test asserts the block names the agent path and links the child thread; `bun run test:browser` only if the link needs a real navigation that jsdom cannot settle, in which case add the `browser-testing` label.
- The picker decision is recorded in `docs/DESIGN.md` and the code follows it.
- `bun run check` passes.
