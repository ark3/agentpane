---
labels: [deferral]
---

# D3 calls the tail upsert "O(1) per token", but it re-sends the whole message, so a turn is quadratic in its own length.

**Runs on the home server** as of 2026-09-13, which has `pi 0.85.1`.
This card carried `work-laptop` until then; the run it asks for no longer needs a trip.

`src/server/http/session-manager.ts:363-378`, `src/server/http/broadcaster.ts`, `docs/DESIGN.md` D3

`#onUpdate` broadcasts `broadcaster.upsert(session.ref, changedIndex, message)`
with the **entire** `AgentMessage`, and Pi emits one `message_update` per token
(`adapters/pi/process.ts:435`). So a 40KB assistant turn is re-serialised and
re-`JSON.parse`d in full on every delta.

**This is not Pi's alone.** `recompose` in `src/server/adapters/claude/reducer.ts` returns a `message` effect carrying the whole message on every `content_block_delta`, reaching the same `#onUpdate` through `emitUpdate` in that adapter; Codex arrives there too, by the path OW-nitima describes.
The card named only Pi until 2026-09-15, which is enough to let someone fix one of three backends and believe the card was finished. D3's claim is true per *transcript* —
streaming only ever touches the tail, and completed messages are never re-sent —
but not per *message*, and the document reads as though it were both.

Deferred rather than fixed, on measurement. Profiled 2026-08-19 against a
production build with `e2e/perf-harness.ts`: the client-side render cost
(OW-detepa) was two orders of magnitude larger and buried this completely, and
nothing in the serialisation path reached the top of any profile. This is real
and it is not what makes the UI sluggish. Fix OW-detepa first and re-measure
before spending anything here.

## What 2026-09-15 measured, and what it rules out

Driving `ClaudeReducer` directly with a synthetic 40KB `Write` chunked at 200 characters: 1002 deltas, 1002 upserts, **386KB of payload in total** -- not megabytes, and not quadratic.
The reason is specific to tool arguments and is OW-bizulo's subject: the `arguments` object cannot change until the JSON that carries it closes, so the message being re-sent is the same small message a thousand times over.

So this card's mechanism holds for **growing text** -- an assistant message accumulating tokens, and Codex's `aggregatedOutput` accumulating a command's output -- and does not hold for a streaming tool call's arguments at all.
Anyone starting here should not reach for a delta protocol on the strength of a large file write; that case is not what it appears to be.

The same day's client-side measurement is the more useful redirection, and it agrees with the 2026-08-19 profile above rather than overturning it: the render cost that buried this is still what dominates, and OW-lisaye is now the card that names it.
Read OW-lisaye and OW-bizulo before this one.

## What settling it would involve, when it is worth it

Two routes, neither chosen:

- **Coalesce.** Debounce upserts per `(session, index)` to ~30-50ms in the
  broadcaster. Cheapest, changes no wire type, and cuts both the bytes and the
  client's flush rate. Costs a little latency on the visible token stream, which
  is the thing to judge by looking at it rather than by argument.
- **Send the delta.** A new event carrying the changed block's suffix rather
  than the message. This is what D3 explicitly decided against — "the wire is
  loopback, so no delta protocol", the machinery pipane's SHA-256-verified delta
  sync existed to justify over a real network. Reopening that is a DESIGN
  decision, not an implementation choice; it needs a number showing loopback
  serialisation actually hurts before it is worth reversing a decision made
  against a real alternative.

Either way, **D3's own wording wants correcting in the same change**: "O(1) per
token" should say what it means, which is O(1) in the number of *messages*, and
name the per-message cost it is trading for immutability of everything above the
tail.

## Done when

A measurement, before any code: bytes per turn on the SSE stream as a function
of turn length, from a real Pi turn (`e2e/perf-harness.ts` is synthetic and will
not settle this — it never crosses a socket). If the curve is flat enough at
realistic turn lengths, close this as measured-and-declined with the numbers,
and fix D3's wording anyway.
