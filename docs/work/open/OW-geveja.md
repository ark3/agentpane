---
labels: [deferral]
---

# Pi's `pendingUiRequests` and Claude's `toolNames` are per-turn maps that nothing expires

Two small leaks, one per adapter, neither observable at human session lengths.

`src/server/adapters/pi/process.ts`, `pendingUiRequests` in the adapter state: a dialog request carries a `timeout`, and when Pi times it out the entry stays.
A late `reply()` then writes an `extension_ui_response` Pi rejects, and `handleResponse` raises that rejection as a red-banner error.
`fork()` does not clear the map either, though a rewind abandons whatever was pending.
Expire an entry on its own timeout, and clear the map on fork, with the reply path answering "no such request" quietly.

`src/server/adapters/claude/reducer.ts`, `toolNames`: it maps a `tool_use` id to its name so the result can be labelled, and it is cleared only in `reset()`.
Every other per-turn map is cleared at `result`; this one grows by one entry per tool call for the life of the attached session.
Clear it at `result` like the others, or record why it must survive the turn.

## Done when

A test in `pi/process.test.ts` lets a dialog time out and asserts a late reply produces no error, and a test in `claude/reducer.test.ts` asserts `toolNames` is empty after `result`; both fail before the change.
