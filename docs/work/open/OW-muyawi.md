---
labels: [unverified]
---

# The snapshot arm's exemption from the sequence check is contract, but the client suite never replays the wire shape that proves it

Surfaced 2026-09-11 while landing OW-husivu, and investigated by a dispatched reader before filing rather than guessed at.

`reduceServerEvent` in `src/client/session-state.ts` handles `snapshot` in an early-return block that does **not** call `acceptsSequence`, unlike the `renamed` arm and the shared tail that serves `upsert`, `status`, `error` and `request`.
That exemption is correct and deliberate, and this card does not propose changing it.

## Why it is correct, so nobody "fixes" it

`src/shared/protocol.ts`, in the `ServerEvent` docblock: "Snapshots reset the sequence."
`src/server/http/broadcaster.ts` sends two kinds, and its class docblock calls the distinction the whole trick:

- `broadcastSnapshot` sets the session's counter to `0` and sends `seq: 0` to every client.
- `sendSnapshot` sends the counter's current value and leaves it untouched, for one newly connected client catching up.

Neither is `view.seq + 1` except by coincidence.
An adjacency check there would reject a `seq: 0` broadcast snapshot at a client sitting at 7, fire `recover`, which attaches, which calls `broadcastSnapshot`, which arrives as `0` and is rejected again.
The check would convert every repaint into an unbounded recovery loop.

## What is actually missing

Two things, and the second is the one that matters.

A reader auditing that arm meets no local note.
The docblock nearest the snapshot block now talks about `compaction` (OW-husivu, `ffde687`), and the answer to "why no sequence check here" lives in `broadcaster.ts` and `protocol.ts`, a module away.

And the client suite never exercises the shape the server actually sends.
Every snapshot fixture in `src/client/session-state.test.ts`, `src/client/controller.test.ts` and `src/client/App.test.ts` carries a seq that is accidentally adjacent or lands on a view with no seq at all -- the `seq: 7` case in `session-state.test.ts` ("replaces a transcript and resets sequence on snapshot") applies it to a view holding no prior seq, where `acceptsSequence` returns true regardless.
So no client test distinguishes the exemption from a check that happens to pass, and a future change adding the check would go green.
The server pins the wire values that make the check wrong (`src/server/http/app.test.ts`, the re-attach assertion that a broadcast snapshot carries `seq: 0` while clients are mid-count) and `src/server/http/testing/sse-client.ts` encodes the same exemption in the reference client -- but nothing holds the real reducer to it.

## Done when

A test in `src/client/session-state.test.ts` replays the production shape against the reducer: a snapshot at some seq, an `upsert` at seq+1, then a **broadcast** snapshot at `seq: 0`, then an `upsert` at `seq: 1`.
It asserts the `seq: 0` snapshot is applied and that no recovery is requested, and that the following `upsert` is accepted rather than read as a gap.
Watch it go red by adding `acceptsSequence` to the snapshot arm before deleting that line again -- a test that has never failed has not been shown to test anything, and here the red run is also what proves the loop this exemption avoids.

And a short note in the snapshot arm itself saying the exemption is the contract, citing `protocol.ts`'s "Snapshots reset the sequence" rather than restating the reasoning, so there is one copy and a pointer.
