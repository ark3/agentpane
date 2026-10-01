---
labels: [defect]
closed: done
---

# The Codex subagent card shows a red error badge with an empty body when a collab call fails, and glues several children's replies together with nothing saying which child said which.

`src/server/adapters/codex/mapping.ts` (the `case "collabAgentToolCall"` arm OW-benige added — `replies`, `join`, and `isError`), `src/client/render/tools/SubagentTool.svelte`, `src/client/render/tools/ResultBody.svelte`.

Two presentation gaps in the block OW-benige built, both in shapes no capture has exercised.
`resources/fixtures/codex/subagent.jsonl` (`codex-cli 0.153.4`) drives one `spawnAgent` and one `wait`, one child, both `status: "completed"`, so neither path below has ever been seen.

## The empty error card

`isError` is `item.status === "failed"`, and the result content is the children's messages from `agentsStates` joined together.
A failed call whose `agentsStates` carries no message gives `content: [{type:"text", text:""}]`, which `ResultBody` renders as nothing: a red-bordered card with an error badge and zero explanation of what failed.
`CollabAgentToolCallStatus` is `"inProgress" | "completed" | "failed"` (`resources/codex-protocol/v2/CollabAgentToolCallStatus.ts`), and the item carries no error field, so there may be nothing better to show — in which case the fix is text the card supplies itself, not data it extracts.

## The unattributed join

`receiverThreadIds` is an array, and the reply text is `replies.join("\n\n")`.
With two children that both answered, the body is two answers glued together and the card lists both ids above it, so a reader cannot pair a reply with the child that gave it.
Whether Codex ever populates more than one receiver on a single call is itself unmeasured; the protocol type permits it.

## Why this is a deferral

Both need a capture to settle, and the one that exists shows neither.
Fixing them now means guessing at the shape and writing tests against hand-built data, which is what the deferral buys time against.

## Done when

Either a capture drives one of these shapes and the card renders it legibly with a fixture-driven test, or a run establishes the shape does not occur and that is recorded where D19 states the card's scope.

## Amended 2026-09-30 by OW-zadupu

Both shapes now have a capture, on the home server on `codex-cli 0.157.1` with `gpt-5.6-luna`: `resources/fixtures/codex/collab-failed.jsonl` and `collab-multi.jsonl`, with their rollouts; `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)".
A `wait` on an id that names no child came back `status: "failed"` with that receiver marked `notFound` and no message, which `mapItem` maps to an error result with an empty body: the empty error card, as predicted.
A `wait` naming two finished children came back with both messages, which maps to `"Hello\n\nHello"` with nothing saying which child said which.
A `wait` returned as soon as its first child finished and named only that child, so a multi-receiver result needed both children done before the wait; the committed run sleeps 15 seconds first.
The protocol has moved under the "empty error card" section: as of the 0.156.0 bindings in `resources/codex-protocol/`, `CollabAgentToolCallStatus` is `"inProgress" | "completed" | "failed" | "interrupted"`.
So the deferral's reason, that no capture showed either shape, is gone; what remains is a presentation decision for each, made against these fixtures: what text the failed card supplies when the item carries none, and how a reply is attributed to its child.

## Decided 2026-10-01 with the owner

The fix is text, written by the `collabAgentToolCall` arm of `mapItem` in `src/server/adapters/codex/mapping.ts`, so live and preview (which since OW-luvema both go through `mapItem`) and both clients (agentpane-mode draws the result text the server made, through `src/emacs/nodes.ts`) all get it from one change.
A structured per-child result, drawn by each client and carried to Emacs as a typed `ToolPart` field, was declined as more than this shape is worth: it arises only on a thread another client drove.

- **Attribution.** With more than one receiver, each child's part of the result is prefixed by its short id.
  The order follows `receiverThreadIds`, as the reply list does today.
- **A child with no message** contributes its `CollabAgentState` status in words instead (`notFound` reads "not found", and so on for every `CollabAgentStatus` in `resources/codex-protocol/v2/CollabAgentStatus.ts`), prefixed the same way, so `collab-failed.jsonl`'s card says the child was not found rather than nothing.
  A failed call whose `agentsStates` names no receiver at all gets a fixed sentence saying the call failed and Codex gave no reason.
- **One receiver with a message** keeps today's body, the message alone.

**The short id changes from the first 8 characters to the last 8.**
Codex thread ids are UUIDv7, whose leading characters encode the creation time, so two children spawned in the same second share them: in `collab-multi.jsonl` the two children are `01a0f517-0458...` and `01a0f517-04e0...`, and the header reads `wait · 01a0f517 · 01a0f517`.
The trailing characters are random.
`toolSummary` in `src/client/render/tools/summary.ts` (its `subagent` branch, `id.slice(0, 8)`) and the mapping's prefixes use the same short form, from one definition, so the header and the body name a child the same way.
OW-gakide's body, which says the header shows "each id's first 8 characters", is corrected in the same change.

## Done when, amended

Each watched red first.

1. A mapping test driven by `collab-failed.jsonl` asserts the failed `wait`'s result names the child by its short id and says it was not found, and that the result is non-empty.
2. A mapping test driven by `collab-multi.jsonl` asserts the two-child `wait`'s result carries each child's distinct short id beside its reply.
3. A `toolSummary` test asserts two thread ids sharing their first 8 characters give a header naming them differently; `src/emacs/nodes.test.ts`'s assertion on `id.slice(0, 8)` moves to the new short form.
4. The existing single-child `subagent.jsonl` tests keep their reply text unchanged, and `src/server/sessions/codex-conformance.test.ts` lists no new difference.

`bun run check` passes.
The earlier "Done when" above is superseded by this one.

## Close note

Landed on main as 8a97b83, after the owner decided on 2026-10-01 to fix this in the mapping text (option A, structured per-child results declined) and to fold in the short-id fix.
`collabResultText` in `src/server/adapters/codex/mapping.ts` builds a collab call's result body. One child with a message gets that message alone. Otherwise each child with a state gets `<short id>: <message>`, or its status in words when it has none (`COLLAB_STATUS_WORDS`, e.g. "not found"). A failed call with no receiver state reads "The call failed, and Codex gave no reason." The short id is now `shortThreadId` in `src/shared/thread-id.ts`, the last 8 characters, because the first 8 of a UUIDv7 are a timestamp that siblings share. `toolSummary`'s header uses the same short id, so header and body agree, and agentpane-mode gets both through `src/emacs/nodes.ts`.
Verified: new tests in `reducer.test.ts` (collab-failed, collab-multi) and `subagent.test.ts` (two same-second children), plus the moved assertion in `nodes.test.ts`, each watched red on the old code. `bun run check` is green on main with 1610 tests. The adversarial read replayed both rollouts and found live and preview agree on the text. The fallback-path preview never produces a `subagent` card.
Visible side effect, flagged to the owner: a spawn's completion reports its child `pendingInit`, so a spawn card's body now reads "<id>: starting" where it was empty.
Filed from the read: OW-lamoso, a stale count of collab tools in the `CODEX_TOOL_NAMES` docblock.
