---
labels: [defect, emacs]
---

# The Emacs helper drops a sessions/detach or sessions/close that names a ref older than the last one it told Emacs

Found 2026-09-25 by the adversarial read of OW-kimaya, confirmed by reading only; not reproduced against a running helper.
It predates OW-kimaya: the ref-keyed helper on `main` before that card missed the same case.
In service of Emacs's detach and close always reaching the session Emacs means, which the parity rule in `AGENTS.md` ("Both clients") makes as load-bearing as the browser's.

## What happens

`src/emacs/helper.ts` keeps `attached`, a map from each handle Emacs attached to the `sessionKey` of the ref it last told Emacs (`told`).
`forget(session)`, which `sessions/detach` and `sessions/close` call, drops a handle when `told` equals the ref Emacs sent, or when the reducer's view for that ref carries the handle.
Emacs names a session by the last ref it processed, and it re-keys only when it gets around to handling `session/renamed`, which it does asynchronously.
The helper applies a `renamed` and the snapshot that follows it one after the other.
So if Emacs sends a detach or close naming the old ref after the helper has processed both events, neither check matches: `told` already holds the new ref, and no view carries the old one.
A detach then does nothing, and events keep going to a buffer the user detached.
After a close, the handle stays in `attached`.

## What would fix it

Either the helper keeps every ref it has told Emacs for each handle, the way the server keeps `ManagedSession.names`, or Emacs sends the handle its buffer holds on `sessions/detach` and `sessions/close` once OW-danifa keys buffers by handle, and the helper resolves by that.
The second fix removes the need for the ref lookup entirely.
If OW-danifa is still open when this card is picked up, it is the better home for the fix, and this card closes `--moot` with that id in the close note.

## Done when

A test in `src/emacs/helper.test.ts`, red first against the current helper: attach a session, deliver `renamed` and its snapshot, then send `sessions/detach` with the pre-rename ref, and assert that no further notification for that session reaches Emacs.
