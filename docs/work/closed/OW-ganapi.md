---
labels: [deferral]
closed: moot
---

# An attach after `close()` of a starting session can await the torn-down startup and fail instead of starting afresh

Found 2026-09-25 by OW-suyinu's adversarial read; the same on `main` before OW-suyinu, so not a regression.
In service of a close followed by a re-open always reaching a live session.

`attach` in `src/server/http/session-manager.ts` registers each startup in `#attaching` under the spelling it was asked for and deletes it in its own `finally` once the startup settles.
If `close(K)` lands during a start whose `adapter.start()` does not settle promptly once the adapter is disposed, the torn-down `PendingStart` stays in `#attaching` under `K` until it does, and an `attach(K)` in that window finds it (`const inFlight = existing ? existing.starting : this.#attaching.get(key)`), awaits it, and rejects with `UnknownSessionError` instead of starting a fresh adapter.
`close()` does not remove the entry: it only sets `torndown`.

Judged not worth blocking on: every real adapter's `start()` rejects promptly once its child is killed, as far as anyone has observed, so the window is as long as a kill.

Done when a test holds a start open past its disposal (`FakeAdapterFactory` `holdStart`), closes it, attaches the same ref, and the attach resolves with a new adapter -- red first -- or when a measurement on all three backends shows `start()` settling at dispose and this card closes `--moot` with that evidence.

## Close note

Duplicate of OW-14, and both are superseded by OW-bulanu (landed 2026-09-29): `close()` now retires the startup it flags from `#attaching` and `container.starting` before its first await, through the single `#retire`, so an attach after it starts afresh.
This card's own done-condition is met by "starts afresh for an attach that follows a close of a session whose start outlives its disposal" in `src/server/http/session-manager.test.ts`: `holdStart` holds the start past its disposal, and the re-attach resolves with a new adapter; on the previous `main` it rejected `UnknownSessionError`.
