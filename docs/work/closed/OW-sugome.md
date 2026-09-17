---
labels: [defect]
closed: done
---

# A sequence-gap recover() can respawn a session the user just detached

Found while reviewing OW-tewave, which put the first client-side caller of the `DELETE` route behind a Detach item in the composer's Tools menu.

`src/client/controller.ts`: `onEvent` fires `void recover(ref)` on any sequence gap, and `recover` calls `api.attach` with no check against a detach in flight or against the session having just been dropped from `view.state.sessions`.
Nothing serialises the two.
A gap landing in the window around a detach therefore re-spawns the subprocess behind the user, leaving a read-only preview on screen over a session that is live again on the server.

Before OW-tewave the only way to reach that window was a reaper that does not exist yet, so this is newly reachable rather than newly written.
It needs a dropped SSE event inside the detach's window, so it is unlikely; it self-heals on the next attach, and it is not known to have been observed.

What is load-bearing: `recover`'s missing guard, not the detach path, which OW-tewave's review already fixed for the selection race it did have.

Done when a controller test drives a sequence gap for the ref a detach is closing and asserts the client does not re-attach it -- red first against today's `recover`.

## Close note

Fixed on `main` as 5e0f679 (implemented on a worktree branch as 86ccf61).

`createController` now holds a `detaching` set of session keys: `detach()` adds the key before `await api.close(selected)` and releases it in that try/catch's `finally`, which runs synchronously before the live view is dropped from `view.state.sessions`, so nothing can interleave between the release and the delete.
`recover()` returns early for a key that set holds.
Outside that window a gap was already harmless and stays untouched: the detach has dropped the view, so `acceptsSequence` in `src/client/session-state.ts` sees no `seq`, and the reducer asks for no recovery at all -- the `recover` docblock now records that, citing OW-sugome.

Verified red first, by the implementer and again in the dispatching session's own run: with the `detaching.has(key)` guard commented out, the new `controller.test.ts` case "does not re-attach a session whose detach is still in flight when its sequence gaps" fails with `expected "spy" to not be called at all, but actually been called 1 times` on `api.attach`.
Green with the guard: `bun run check` clean, 1107 tests in 50 files, 22.5s.
No browser check -- nothing here is visible to `bun run test:browser`.

Noticed and not done, both pre-existing and outside this card: `detach()`'s `catch` arm returns without restoring anything, so a failed close leaves the session attached and selected under the published error; and `recoveries` keys on `sessionKey`, so a `renamed` mid-recovery leaves a stale key until its own `finally` clears it.
