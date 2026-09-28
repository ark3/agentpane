---
labels: [change, d25]
closed: done
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

## Close note

Landed in 20e8174. In the browser, a sequence gap now detaches that one session in the tab: `detachGapped` in `src/client/controller.ts` drops its live view and calls neither `api.attach` nor `api.close`, since the server still holds the session for other clients. `recover`, `recoveries` and OW-sugome's `detaching` set are gone.
A selected session lands on its preview, fetched under the gapped event's ref so that a gap which swallowed a rename (D24) previews the new ref. It lands only if the intent is unchanged, the selection still names the session, and no snapshot brought the view back. A failed fetch falls to the startup view silently. The gap writes neither busy nor error.
This deliberately differs from the card's "ends where detach() leaves one" for a session with nothing on disk. `detach()` sends that case to the startup view because its Attach can only 404 (OW-vasubu). After a gap the server still holds the session, so the preview's Attach works: `SessionManager.attach` answers a live ref with a snapshot and no spawn, and `readSessionPreview` answers [] for a ref with nothing on disk.
The reducer still reports gaps as `recover: Recovery[]`, because the Emacs helper answers them with an attach until OW-filuge; renaming the field fits there.
D3's "recovery is re-snapshot" is amended where it was copied: `src/shared/protocol.ts`, `src/server/http/broadcaster.ts`, and `docs/DESIGN.md`.
Verified by seven new controller tests, each watched red first (the no-attach, rename-ref, no-disk-preview and intent-guard tests among them); the recover tests are rewritten or removed and named in the commit message. `bun run check` passes, with 1482 tests.
Its adversarial read filed OW-tefigi. There, an attach reply landing after a gap has dropped the view leaves a selection with neither view nor preview, and any snapshot after a preview leaves both, because no single place owns the view/preview pairing. OW-wazija, which reaches the same landing through a stream drop, was cross-referenced to it.
