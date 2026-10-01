---
labels: [deferral]
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
