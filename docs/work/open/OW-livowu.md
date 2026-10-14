---
labels: [defect]
---

# The Pi preview reads only message entries, so a compaction Pi stored as a compaction entry draws no marker where the live transcript draws one

Filed 2026-10-14 by the execution of OW-piyulu, from its `compact-session` capture on `pi 1.2.0`.

Live, `reducePiNotification` in `src/server/adapters/pi/reducer.ts` appends a `compactionSummary` message when `compaction_end` arrives, carrying `tokensBefore` and the summary, and both clients draw it as the compaction marker.
Stored, as of `pi 1.2.0`, Pi writes the same compaction as a `type: "compaction"` entry, not a `type: "message"` one, carrying `summary`, `firstKeptEntryId`, `tokensBefore`, `details`, `usage`, `fromHook` and `systemMessage`; see `resources/fixtures/pi/compact-session.session.jsonl`, its last line.
`extractPreviewTurn` in `src/server/sessions/pi.ts` returns null for every entry that is not `type: "message"`, so `extractPiPreviewTurns` drops it, and the read-only preview of a compacted Pi session shows no marker at all.
`storedAgentMessage` in `src/server/sessions/preview-message.ts` already maps a `compactionSummary`-role payload onto the preview wire, so what is missing is the entry, not the shape it maps to.

In service of the preview reading as the live transcript of the same run does, which `src/server/sessions/pi-conformance.test.ts` holds one recorded run at a time.

## What is load-bearing

The marker sits where the compaction happened in the file's order, as it does live, and carries the entry's `tokensBefore` and `summary`.
How the Codex preview draws its marker from a rollout's `compacted` record is prior art: `src/server/sessions/codex.ts`, the function that builds a `compactionSummary` turn with `tokensBefore`, and `codex-conformance.test.ts`'s `compact-rollout` scenario, which lists no compaction difference.
Whether a Pi session file can hold a compaction entry on a branch the active leaf does not reach is not this card's question; the preview reads entries in file order today, and this card keeps that.

## Done when

`KNOWN_DIFFERENCES["compact-session"]` in `src/server/sessions/pi-conformance.test.ts` no longer lists the `compactionSummary tokensBefore=5915 summary=present` row under this card, and the test passes, having failed first with the entry removed and the fix absent.
A unit test in `src/server/sessions/pi.test.ts` feeds a session file holding a `compaction` entry and asserts a `compactionSummary` turn with its `tokensBefore` and `summary`, red before the fix.
`bun run check` passes.
