---
labels: [defect]
closed: moot
---

# A Codex subagent_notification message previews as a user turn nobody typed, because SYNTHETIC_USER_PREFIXES does not list it

Found 2026-09-30 by OW-zadupu's conformance test, on the `collab-multi` fixture captured on `codex-cli 0.157.1`.

When a spawned child finishes, Codex writes a user-role message beginning `<subagent_notification>` into the parent's rollout.
`SYNTHETIC_USER_PREFIXES` in `src/server/sessions/codex.ts` (the list `isSyntheticBlock` checks) does not include it, so the preview draws one user turn per finished child, where the live transcript of the same run has none.
It is the same shape as the stored half of OW-yobuyi, whose `<turn_aborted>` notice is also missing from that list; the two may land together, but neither waits on the other.

The evidence is committed: `resources/fixtures/codex/collab-multi.jsonl` and `collab-multi.rollout.jsonl`.
`src/server/sessions/codex-conformance.test.ts` lists it as a known difference in the second `KNOWN_DIFFERENCES["collab-multi"]` hunk, keyed to this card.

## Done when

The preview of `collab-multi.rollout.jsonl` draws no user turn for either notification, and this card's part of that hunk is removed from `KNOWN_DIFFERENCES` — the conformance test fails until it is, which is the red-then-green.

## Close note

Folded into OW-luvema on 2026-09-30: a rollout's `item_completed` `UserMessage` records hold only what the user typed, with none for a `<subagent_notification>`, so the item-record path draws no such turn and needs no prefix list.
Its done-condition removes this card's `KNOWN_DIFFERENCES` entry; a rollout with no item records keeps today's path and `SYNTHETIC_USER_PREFIXES` as they are.
