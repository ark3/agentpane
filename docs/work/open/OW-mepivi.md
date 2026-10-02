---
labels: [deferral, d27]
---

# The Codex name read at thread/start and at a borrowed fork is pinned by a test

`src/server/adapters/codex/adapter.ts` (`start`, where `this.name = started.thread.name ?? null`, and `startBorrowed`, where `this.name = resumed.thread.name ?? null`), `src/server/adapters/codex/adapter.test.ts` ("CodexAdapter session name (D27, OW-jamaha)"), `src/server/adapters/codex/test-support.ts`

OW-jamaha, landed 2026-10-01, reads a Codex thread's name from three answers: `thread/start` or `thread/resume` in `start`, and `thread/resume` in `startBorrowed` for a fork.
Only the `thread/resume` path through `start` has a test ("carries the name thread/resume answers with, before any rename"); the other two could drop their read and stay green.
Deferred because a fresh `thread/start` has no name to read, so only the borrowed fork's path can show a wrong name today, and only for a parent that was named.

## Done when

A test drives a borrowed fork whose `thread/resume` answer carries `thread.name` and asserts the fork adapter's `getState().name` before any rename, watched red with that assignment removed.
