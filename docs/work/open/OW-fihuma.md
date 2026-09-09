---
labels: [defect]
---

# A session closed server-side never leaves the client's state, so the list keeps drawing it live and preview short-circuits into a stale view

`src/client/session-state.ts` has no removal path: `renamed` re-keys a view, `sessions-changed` triggers a re-list, and nothing deletes an entry.
`src/server/http/session-manager.ts`, `close()`, broadcasts only `sessionsChanged()` after a DELETE.
After a close from another tab or from curl, the closed session's `SessionView` stays in `state.sessions` with its last `messages` and `isStreaming`.
`src/client/controller.ts`, `preview()`, short-circuits when a view with messages exists, so the stale transcript is shown instead of the stored one being fetched.
The list row (`App.svelte`, the `session-streaming` span) keeps its dot from that map, and a prompt answers 404 or the `not_attached` 409.

OW-35 is adjacent and is not this: it covers a prompt to a reaped session re-attaching transparently, and its attach-then-submit would not clear the phantom view or the dot.
D12's reaper (OW-33) will produce the same client symptom on every eviction, so whatever this card lands is what OW-33's `sessionsChanged()` call relies on.

The client can learn a session is gone from the re-list a `sessions-changed` triggers: a key in `state.sessions` that the fresh summary list reports as `detached` has lost its process, and its view should drop back to what a never-attached session holds.

## Done when

A test in `controller.test.ts` attaches a session, delivers a `sessions-changed` whose re-list reports it `detached`, and asserts `preview()` fetches rather than short-circuiting and `isStreaming` is false; it fails before the change.
