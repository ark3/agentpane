---
labels: [deferral]
---

# A Pi rename the adapter did not send reaches the listing through session_info_changed

`src/server/adapters/pi/process.ts` (`PiAdapter`, the `name` field's docblock), `src/server/adapters/pi/protocol.ts` (`PiEvent`)

OW-jamaha, landed 2026-10-01, keeps an attached Pi session's name from `get_state` at start and after a fork, and from its own `setName`.
As of `pi 1.0.0`, Pi also emits a `session_info_changed` event at every rename (`setSessionName` in `dist/core/agent-session.js` of the installed `@earendil-works/pi-coding-agent`, read at the source), which the adapter does not read.
So a rename made inside Pi by something other than agentpane -- an extension -- shows in the list only after the next attach or fork.
Deferred because nothing agentpane drives renames a Pi session except `setName`, which already updates the state; take it up if an extension that renames sessions comes into use.

## Done when

A test in `src/server/adapters/pi/process.test.ts` has the fake emit `session_info_changed` carrying a name and asserts `getState().name` follows it and an update is emitted, watched red first; the event's typed arm in `src/server/adapters/pi/protocol.ts` is transcribed from the installed CLI with its version; and the `name` field's docblock no longer says the event goes unread.
