---
labels: [change, d25]
---

# The browser answers a sequence gap by re-attaching the session, which spawns it again when a close is out; a gap should detach that one session

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, which the owner took that day; read D25 first.

## What happens

`reduceServerEvent` in `src/client/session-state.ts` returns a `Recovery` for an event whose `seq` does not follow its view's (`acceptsSequence`), and `recover` in `src/client/controller.ts` answers it with `api.attach(ref)`, whose snapshot restarts the sequence.
That attach spawns the session again if a close of it is out, which is why OW-sugome added the `detaching` set that `recover` reads, and why the reducer's comment on events with no view refuses to request a recovery at all (OW-pezazo).

## The change

A gap detaches that one session, as a stream drop detaches every one: its view goes, with the per-tab state held under its handle, and the selected session ends where `detach()` leaves one.
Nothing is attached on the client's behalf; the user clicks the row to see it again, which is a deliberate attach.
`recover`, `recoveries`, and the `detaching` set if nothing else then reads it, go, along with their docblocks; what a gap now does is stated where `acceptsSequence` is used.
The snapshot arm's exemption from the sequence check stays: a snapshot restarts the count and is never a gap.
OW-muyawi, which pins that exemption, is amended in the same filing to assert that a snapshot does not detach the session, in place of asserting that no recovery is requested.

## Done when

A test in `src/client/session-state.test.ts` or `src/client/controller.test.ts`, red first, delivers an event whose `seq` skips one for a live view, and asserts the view is gone and `api.attach` was never called.
The existing tests of `recover`, among them "does not re-attach a session whose detach is still in flight when its sequence gaps" (OW-sugome), are removed or rewritten, and named in the commit message.
`bun run check` passes.
