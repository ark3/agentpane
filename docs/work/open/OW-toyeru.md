---
labels: [defect]
blocked-by: [OW-jihete]
---

# A Claude Code prompt sent mid-turn is echoed into the transcript at write time, so it appears before the running turn's remaining assistant messages

`src/server/adapters/claude/adapter.ts`, the module docblock: the CLI "queues stdin messages sent mid-turn, so `submit()` does not gate".
That is true of the protocol and wrong of the transcript.
`src/server/adapters/claude/reducer.ts`, `beginTurn`: it pushes the local user echo at the moment `submit()` writes.
The running turn's next `message_start` then opens its slot after that echo, so the queued prompt renders before the assistant messages that answer the previous one, and nothing later corrects the order because the Claude adapter never rehydrates a live session.
The first `result` also drops `isStreaming` to false while the queued turn is still pending, so the composer offers Send on a session that is about to stream again.

Pi does not have this problem because Pi itself emits the steered `message_start`, and the Pi reducer appends nothing locally.

Whether Claude should queue, steer, or reject mid-turn is OW-rifezo; whatever it decides, the echo has to land where the CLI actually starts the turn, which is the `user` record the store file writes or the first `message_start` after the previous `result`.
`resources/fixtures/claude/interrupt.jsonl` and `tool-use.jsonl` show the turn boundary shapes; no fixture has a mid-turn second prompt, and capturing one is part of this card since the home server runs Claude Code on Haiku (AGENTS.md, "Evidence").

## Done when

- A reducer test in `claude/reducer.test.ts` submits during `turnActive`, replays the rest of the first turn, and asserts the echo's index is after the first turn's last assistant message; it fails before the change.
- A test asserts `isStreaming` stays true across the first `result` when a second prompt is queued.
- A captured fixture for the mid-turn prompt sits under `resources/fixtures/claude/` with its `.meta.json`, scrubbed per `resources/fixtures/README.md`.

**Amended 2026-09-09: OW-rifezo answered, and the answer may moot this card.**
D16 makes a mid-turn `submit()` mean steer, and requires a backend that cannot steer to reject rather than queue.
Claude cannot steer, so it must reject — OW-jihete — and this card's blocker is re-pointed there, because the ordering defect described above is a property of the queued mid-turn prompt that OW-jihete stops producing.
If nothing reaches the CLI's queue mid-turn, nothing is misordered and this card is moot.
That is not to be assumed: the second half of this card, the first `result` dropping `isStreaming` to false while a queued turn is pending, needs someone to confirm no path still reaches that queue.
OW-jihete carries the instruction to settle this explicitly rather than let it lapse.
