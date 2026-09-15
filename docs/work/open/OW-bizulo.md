---
labels: [defect, now]
---

# Claude emits one upsert per input_json_delta whose payload is byte-identical to the last, for arguments the authoritative `assistant` event replaces anyway

`src/server/adapters/claude/reducer.ts` -- the `input_json_delta` arm of `handleStreamEvent`, the `partialJson` field on `BlockState`, and `handleAssistant`, whose docblock states the per-block authority this card turns on.

## The contract, and how it is broken

`ServerEvent.upsert` in `src/shared/protocol.ts` means *this message changed*, and D3 in `docs/DESIGN.md` builds on that: the tail upsert carries `{seq, index, message}` and the monotonic `seq` exists so a client can detect a dropped update and re-snapshot.
The `input_json_delta` arm returns `this.recompose(slot)` on every delta, which emits a `message` effect, which reaches `broadcaster.upsert` through `emitUpdate` in `src/server/adapters/claude/adapter.ts` and `#onUpdate` in `src/server/http/session-manager.ts`.

Measured on 2026-09-15 by driving `ClaudeReducer` directly with a synthetic 40KB `Write` chunked at 200 characters: **1002 deltas produced 1002 `message` effects carrying 2 distinct payloads.**
A thousand of those upserts assert a change that did not happen and burn a `seq` increment each.

The reason only two payloads exist is that a prefix of a JSON object never parses, so the `JSON.parse` inside that arm can succeed only on the delta that closes the object, and `arguments` is pinned at its previous value until then.
That is not an artefact of the synthetic input: in `resources/fixtures/claude/tool-use.jsonl` (`claude 2.1.238`) the `Edit` block is 5 deltas with 1 successful parse and the `Read` block is 4 with 1.

This is Claude-only, and Pi already does what this card asks for.
`reduceAssistantDelta`'s `toolcall_delta` arm in `src/server/adapters/pi/reducer.ts` returns the same state reference unchanged, and its comment gives this card's reasoning almost word for word -- partial argument text "is not valid JSON until `toolcall_end` supplies the parsed, complete `ToolCall`", so the arm is "a no-op (same state reference) rather than churn callers must filter out".
Read that arm before writing the Claude one; the shape of the fix is already in the repository.
Codex does not perform a per-delta `JSON.parse` either.
That asymmetry is part of the defect and not incidental to it: the owner's stated reason for valuing agentpane is not having to track which backend is underneath, and this is one backend behaving unlike the other two beneath an abstraction that promises otherwise.

## Why the fix is a deletion rather than a guard

`handleAssistant` holds per-block authority -- its own docblock says the k-th `assistant` event for a message id "carries the completed block at content position k" and "replaces whatever streaming built there".
For a `tool_use` block that completed block carries fully-parsed `input`, which `assistantBlockToContent` turns into the `toolCall`'s `arguments`.
`tool-use.jsonl`'s `event_census` records `stream_event:content_block_start: 7` against `assistant: 7`, so every streamed block is followed by its authoritative event.

`partialJson` is written and read nowhere outside the arm that maintains it (the field declaration on `BlockState`, its initialisation in the `content_block_start` arm, and its two uses inside `input_json_delta`).
So the accumulation and the parse compute a value that is correct only on the last delta and is then overwritten regardless.

Delete the accumulation, the `JSON.parse`, and the `recompose` from that arm, and remove `partialJson` with them once nothing writes it.
That retires both halves at once: the no-op upserts, and the doomed parse, which was separately measured at roughly 85ms of the 228ms the reducer spends on a 160KB write and which a guard could not have removed, since the parse is how you learn it failed.

Nothing found depends on the per-delta emission.
A tool card's `running` state comes from the call having no result yet, not from update frequency, and `setStreaming` is a separate path in the same reducer.
An abort mid-arguments loses nothing either: what is discarded is the last good parse, which in this situation is the empty object the `content_block_start` arm seeded.

## The coupling this creates, and why it must be pinned

After this change, a tool call's arguments come from the `assistant` event and from nowhere else.
That dependency is real and currently invisible, so the card must leave it visible: if a later Claude Code stops emitting per-block `assistant` events under `--include-partial-messages`, tool arguments would silently never populate.

Per AGENTS.md, any claim about backend behaviour names the version it was measured on -- the census above is `claude 2.1.238`, captured 2026-08-25.

## Done when

`src/server/adapters/claude/reducer.test.ts` carries two cases, both failing before the change:

- Feeding a `tool_use` `content_block_start` followed by several `input_json_delta` events emits no `message` effect for any of them.
- Feeding those same deltas and then the authoritative `assistant` event yields the complete `arguments`, which is what proves the deletion lost nothing.

A third case guards the coupling: assert that the arguments are absent until that `assistant` event arrives, so a reader meets the dependency as an assertion rather than having to infer it.

Do not close this on a timing measurement.
The claim is that an upsert is emitted when the message did not change, and consecutive payloads being byte-identical is the observable; OW-detepa's docblock in `src/client/App.streaming-cost.test.ts` argues the counts-not-milliseconds choice for the client side of the same question, and the reasoning carries.
