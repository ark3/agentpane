---
labels: [deferral]
---

# Every Codex delta rebuilds the whole transcript array and rescans every slot, which is linear in the transcript per token

`src/server/adapters/codex/reducer.ts`, the delta path: `this.messages = this.flattenMessages()` on every update, and `startIndex(slot)` walks all slots before it to find the changed message's index.
Pi's reducer replaces one element; Codex re-derives the array from its stored items each time.
That is O(messages) per token on the server, on top of the wire cost OW-luzipe records for the tail upsert.
At the hundreds of messages a captured session holds it is invisible; at thousands it will show.

Deferred because no session has been measured at that length.
The card that measures it should use the `compact.jsonl` fixture replayed several times over as its input, which is a reducer test rather than a browser one.

## Done when

A reducer benchmark under `src/server/adapters/codex/` records the per-delta cost at one, ten, and fifty replays of `compact.jsonl`, and either the cost is flat after the change or the number is recorded here as acceptable.
