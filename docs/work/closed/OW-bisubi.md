---
labels: [defect]
closed: done
---

# Codex session previews still draw a compaction marker with no token figure, unlike the live transcript

`src/server/sessions/codex.ts`, the `if (payload.type === "context_compaction" || payload.type === "compaction")` arm, which returns a `SessionPreviewTurn` with `tokensBefore: 0` hardcoded.

OW-kelomi gave Codex's *live* compaction marker a real pre-compaction figure: the reducer samples `last.totalTokens` at `item/started contextCompaction` and hands it to `mapItem` on `MapContext.tokensBefore`.
The session-*preview* path is a separate reconstruction -- it reads the on-disk rollout rather than the live app-server stream -- and was not touched, so the same compaction now renders with a figure in the transcript and without one in the session list.
That inconsistency is the defect; a reader who sees both surfaces has no way to know they are the same event.

Noticed by OW-kelomi's implementer and deliberately left: its card named the live stream only.

## What nobody has checked

Whether the rollout on disk carries a usable usage entry at all, and if so whether one sits near enough to the compaction record to mean "context before".
That is the first question, and it may answer the card by itself: if the rollout has no such entry, the honest outcome is a comment at that arm saying so, not a figure.
Do not reach for `total` if you find one -- it is cumulative for the thread and climbs straight through a compaction; OW-kelomi has the numbers.

A rollout to read is whatever `resources/probes/capture_fixtures.py --scenario compact` leaves behind, or any `~/.codex` rollout containing a compaction; the committed `resources/fixtures/codex/compact.jsonl` is the app-server *stream*, not the rollout, so it cannot answer this.

## Done when

Either a preview test drives a rollout containing a compaction and asserts a specific non-zero `tokensBefore` that means the same thing the live marker's does -- watched red first -- or the arm carries a comment naming the rollout field that was looked for, the version it was looked for on, and what was there instead.
`bun run check` passes either way.

Load-bearing: the figure means the same thing wherever it appears, which is why OW-kelomi refused a field that measured something else.
Incidental: whether the preview shows a figure at all, if the data turns out not to be there.

## Amended 2026-09-13, during execution

The headline's premise is wrong, and the correction makes the card bigger rather than smaller.
The preview draws **no** compaction marker for Codex at all.
`extractStoreTurn` builds `payload` only from a record whose top-level `type` is `response_item` (or from a bare `type: "message"` record, which then has `payload.type === "message"`), so the `context_compaction`/`compaction` arm is reachable only by a `response_item` carrying that payload type -- and no such record exists.
Census over the 88 rollouts under `~/.codex/sessions` on the home server, 2026-09-13: `response_item` payload types are `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `message`, `function_call`, `function_call_output`, `agent_message`, and nothing else.
Compaction is recorded instead as a **top-level `type: "compacted"`** record whose `payload` has no `type` field at all (keys: `message`, `replacement_history`, `window_number`, `first_window_id`, `previous_window_id`, `window_id`, plus on 0.153.0 `compaction_response_id`, `guardian_history`, `latest_token_usage_record`).
0.150.1 also writes a separate `event_msg` / `context_compacted` a few ms later; matching that too would double-count.

So the hardcoded `tokensBefore: 0` is currently moot, and the card cannot be answered without first matching the record that actually exists.

### The question the card asked, answered

The rollout **does** carry a figure meaning the same thing as the live marker's.
Live, `tokensBefore` is `ThreadTokenUsage.last.totalTokens` sampled at `item/started contextCompaction` (`src/server/adapters/codex/reducer.ts`, the `compactionTokensBefore` map).
On disk the same quantity is `payload.info.last_token_usage.total_tokens` of the **last `event_msg` / `token_count` record strictly before the `compacted` record**.

Measured on the three rollouts that contain a compaction:

- 0.147.0 -- `token_count.payload.info` is `null` throughout; no figure available, `tokensBefore` stays 0.
- 0.150.1 -- last `token_count` before: `last=207782`; first after: `last=6925`.
- 0.153.0 -- last `token_count` before: `last=226760`; first after: `last=14671`.

Two near misses that must not be taken:

- `total_token_usage` / `thread_token_usage` are cumulative and climb straight through the compaction (0.150.1: 11095489 on both sides). This is the field OW-kelomi already refused.
- A bare top-level `token_usage_record` sits nearer the `compacted` record on 0.153.0 (index 808, `usage=231383`) but is the **compaction call's own** usage, not the standing context -- the disk analogue of the live stream's mid-compaction sample that `mapping.ts` deliberately skips. Selecting "nearest usage record of any type" picks it and is wrong; filter to `event_msg` / `token_count`.

0.154.0 is present on the home server but wrote no compaction in any rollout, so it is unmeasured.

### Done when, amended

A preview test drives a rollout fixture containing a top-level `compacted` record preceded by `token_count` records and asserts the preview turn is a `compactionSummary` carrying that specific non-zero `tokensBefore` -- watched red first, since today the preview emits no marker at all.
A second case covers the 0.147.0 shape, where `info` is `null` and 0 is the honest answer; the arm carries a comment naming that version and what was there instead.
`bun run check` passes.

## Close note

Landed as c372199 on main.

The card's headline premise was wrong, and the correction made the work bigger: the preview drew no Codex compaction marker at all.
`extractStoreTurn` builds `payload` only from a top-level `response_item` record (or a bare `type: "message"` one), so the `context_compaction`/`compaction` arm was reachable only by a `response_item` carrying that payload type, and none exists.
Census over the 88 rollouts under `~/.codex/sessions` on the home server, 2026-09-13: `response_item` payload types are exactly `reasoning`, `message`, `agent_message`, `custom_tool_call`(+`_output`) and `function_call`(+`_output`).
Compaction is a top-level `{"type":"compacted"}` record whose payload has no `type` field.
The card body carries the full amendment.

What the card asked -- does the rollout carry a figure meaning what the live marker's means -- is yes.
It is `payload.info.last_token_usage.total_tokens` of the last `event_msg`/`token_count` record strictly before the `compacted` record.
Measured: `codex-cli` 0.150.1 reads 207782 before and 6925 after; 0.153.0 reads 226760 and 14671; the one 0.147.0 rollout has `info: null` on the only `token_count` before its compaction, so 0 is the honest answer there.
0.154.0 is installed on the home server but wrote no compaction in any rollout, so it is unmeasured.

Two near misses were checked and refused, and the docblock at `compactionTurnFor` records both.
`info.total_token_usage` is cumulative and reads 11095489 on both sides of the 0.150.1 compaction -- the same field OW-kelomi refused on the live path.
A top-level `token_usage_record` sits *nearer* the `compacted` record on 0.153.0 (`usage.total_tokens` 231383) but is the compaction call's own usage, the disk analogue of the mid-compaction sample `mapping.ts` deliberately skips; a rule of "nearest usage record of any type" picks it and is wrong.

The dead arm was deleted rather than kept.
`resources/codex-protocol/ResponseItem.ts` does declare `compaction` and `context_compaction` variants -- they are wire shapes never persisted to a rollout -- and the docblock says so, so the next reader does not read the deletion as a mistake.

Three preview tests in `src/server/sessions/preview.test.ts`, all watched red first against the pre-fix code, and each re-checked by removing the specific line it covers.
They pin the figure, the two decoys (the `token_usage_record` and 0.150.1's trailing `event_msg`/`context_compacted`, which would otherwise draw a second marker for one compaction), that a null `info` does *not* clear a figure already seen, and that the figure IS cleared as a marker is drawn -- so a second compaction with no `token_count` between borrows nothing, which is the borrow the live reducer keys by item id to prevent.

An adversarial reader at the finished work found the docblock claiming `info` was null "throughout every 0.147.0 rollout" (false -- the two `token_count` records after that compaction carry a populated `info`), the null-`info` test passing for the wrong reason (it asserted the initial value of the field, and passed with the whole `token_count` arm deleted), and the borrow above. All three were fixed before landing.

Filed OW-wapage: a rollout's `compacted.payload.message` holds compaction-summary prose the live stream structurally cannot supply, so the preview could show a `summary` the transcript never can. Left empty; the decision is unmade.

`bun run check` passes: 49 files, 1064 tests.
