---
labels: [defect]
closed: moot
---

# A failed Codex tool call previews as a success, because extractStoreTurn sets isError false on every stored tool result

Found 2026-09-30 by OW-zadupu's conformance test, on the `collab-failed` fixture captured on `codex-cli 0.157.1`.

`extractStoreTurn` in `src/server/sessions/codex.ts` builds every stored tool result with a literal `isError: false`, whatever the record says.
Live, the same run's failed collab `wait` (`status: "failed"`, its child `notFound`) maps to a `subagent` tool result with `isError: true`, so the browser and agentpane-mode draw an error there and the preview of the same session draws a success.

The evidence is committed: `resources/fixtures/codex/collab-failed.jsonl` (the stream) and `collab-failed.rollout.jsonl` (the rollout of the same run).
`src/server/sessions/codex-conformance.test.ts` lists this as a known difference in `KNOWN_DIFFERENCES["collab-failed"]`, keyed to this card.

What the rollout gives the preview to read failure from is for the picker to find: the failed call is an `exec` script on disk (see OW-kelise for that mechanism), so the failure may sit in the script's output text, in the `item_completed` record for the collab call, or both.
Read `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)", before choosing.

## Done when

The preview marks the failed result `isError: true` on `collab-failed`, and this card's entry is gone from `KNOWN_DIFFERENCES` in `codex-conformance.test.ts` — that test fails until the entry is removed, which is the red-then-green.
A unit test in `src/server/sessions/codex.test.ts` or `preview.test.ts` covers the record shape the fix reads, and was shown red before the fix.
The hardcoded `isError: false` is gone from `extractStoreTurn`.

## Close note

Folded into OW-luvema on 2026-09-30, which has the preview build items from the rollout's `item_completed` records through `mapItem`; the `CollabAgentToolCall` record carries `status: "failed"` on `collab-failed`, so the failed result previews as an error there.
Its done-condition removes this card's `KNOWN_DIFFERENCES` entry; a rollout with no item records keeps today's path and its `isError: false`, accepted as a first cut.
