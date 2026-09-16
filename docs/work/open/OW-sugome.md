---
labels: [defect]
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
