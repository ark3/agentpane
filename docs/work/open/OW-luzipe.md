---
kind: deferral
where: '`src/server/http/session-manager.ts:363-378`, `src/server/http/broadcaster.ts`, `docs/DESIGN.md` D3'
---

# D3 calls the tail upsert "O(1) per token", but it re-sends the whole message, so a turn is quadratic in its own length.

**Work laptop:** needs a live Pi run.

`#onUpdate` broadcasts `broadcaster.upsert(session.ref, changedIndex, message)`
with the **entire** `AgentMessage`, and Pi emits one `message_update` per token
(`adapters/pi/process.ts:435`). So a 40KB assistant turn is re-serialised and
re-`JSON.parse`d in full on every delta. D3's claim is true per *transcript* —
streaming only ever touches the tail, and completed messages are never re-sent —
but not per *message*, and the document reads as though it were both.

Deferred rather than fixed, on measurement. Profiled 2026-08-19 against a
production build with `e2e/perf-harness.ts`: the client-side render cost
(OW-detepa) was two orders of magnitude larger and buried this completely, and
nothing in the serialisation path reached the top of any profile. This is real
and it is not what makes the UI sluggish. Fix OW-detepa first and re-measure
before spending anything here.

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
