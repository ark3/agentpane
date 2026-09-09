---
labels: [defect]
---

# The Codex reducer applies item notifications from every thread on the connection, so a spawned subagent's conversation lands inline in the parent transcript as a phantom turn.

`src/server/adapters/codex/adapter.ts` (`onServerMessage`), `src/server/adapters/codex/reducer.ts` (`handleNotification`, the `item/started`, `item/completed` and `item/*/delta` arms), `src/server/adapters/codex/mapping.ts` (`SILENT_ITEM_TYPES`), `resources/probes/capture_fixtures.py` (`SCENARIOS`).

Observed by the owner (2026-09-09): when a Codex session spawns a subagent, the transcript shows a fresh turn whose user message is the caller's spawn prompt and whose assistant output is the subagent's reply, indistinguishable from a turn the owner drove.

## Mechanism, read from the code

Codex's app-server hosts the spawned agent as a separate thread on the same connection, and every item notification carries a `threadId` (`resources/codex-protocol/v2/ItemStartedNotification.ts`, `ItemCompletedNotification.ts`).
`onServerMessage` drops `turn/started` and `turn/completed` whose `threadId` is not the adapter's own, then hands every message to the reducer regardless.
The reducer's `item/started`, `item/completed` and delta arms never read `threadId`, so the child thread's `userMessage` and `agentMessage` items are slotted and mapped into the parent's message list.
The reducer's `thread/started` arm also overwrites its own `threadId` with the child's when the child thread starts; nothing reads that field today, so this is latent, but the fix should leave it correct rather than clobbered.
The one item Codex does put in the parent thread for this, `subAgentActivity`, sits in `SILENT_ITEM_TYPES`, so the honest signal is dropped and the wrong one is shown.

## Evidence on disk

Codex keeps the two threads apart in its own store.
A collab session on the home server, `~/.codex/sessions/2026/08/31/rollout-2026-08-31T16-38-15-01a0598b-*.jsonl`, holds only its own two user turns, the `spawn_agent` and `wait_agent` calls, and `sub_agent_activity` events naming the child thread id.
The child's whole conversation is in `rollout-2026-08-31T16-39-29-01a0598c-*.jsonl` in the same directory, whose `session_meta` carries `thread_source: subagent` and `forked_from_id` naming the parent.
A consequence worth a test of its own: a reattach rebuilds from `thread/resume` for the parent thread alone, so the phantom turn is present while watching live and gone after a reattach.

This mechanism is inferred from the protocol types and the rollouts, not from a captured app-server stream.
No fixture under `resources/fixtures/codex/` drives a collab session; OW-vefiso closed on that same gap and left `collabAgentToolCall` silent for want of a capture.

## Done when

- A new `capture_fixtures.py` scenario drives one Codex turn that spawns a subagent and waits for it, and its capture is committed under `resources/fixtures/codex/` with a `.meta.json` like the others.
  Whatever that capture shows about which notifications arrive for the child thread, record it in the meta note and in `docs/HANDOFF.md`, because it settles the inference above either way.
  This needs a live Codex run, which the home server can do: `codex -m gpt-5.6-luna` per AGENTS.md, and the subagent inherits whatever model the spawn names.
- Item and delta notifications whose `threadId` is not the adapter's thread produce no message, and the reducer's `threadId` stays the parent's after the child's `thread/started`.
  A `reducer.test.ts` case driven by the new fixture asserts the parent transcript holds only the parent's own user and agent messages, watched red against the current reducer first.
- `bun run check` passes.

The rendering of the subagent as something honest in the parent transcript is OW-benige, which waits on this fixture.
