---
labels: [defect, now]
closed: done
---

# The Claude Code adapter resolves `start()` before its child has proven it is alive, so a failed spawn becomes an attached session that cannot take a prompt

`src/server/adapters/claude/adapter.ts`, `start()`: both branches end in `attachProcess(...)` and return.
`attachProcess` is synchronous; nothing round-trips the child before `start()` resolves.
Compare the other two adapters: Pi round-trips `get_state` inside `start()` (`src/server/adapters/pi/process.ts`, the comment beginning "left the `get_state` probe below pending forever") and Codex round-trips `initialize`, so a missing `direnv`, a refusing `sbox`, or an ENOENT rejects `start()` and `SessionManager` reaps the startup.
For Claude the spawn failure surfaces later, through `onError` only.
The manager broadcasts that as a session error and leaves the adapter in its table, where every `submit` throws "Claude Code process is not running".
DESIGN's "What the wrapper chain does to process events" describes exactly this hazard: "a failed spawn emits `error` and `close`, never `exit`", and "an adapter that reaps on `exit` alone will not reap a spawn failure".

There is no test of a failed Claude spawn anywhere under `src/server/adapters/claude/`.

What the probe should be is the implementer's call from the fixtures: `resources/fixtures/claude/session-id.jsonl` and `control-discovery.jsonl` show what the CLI emits at startup, and OW-yilabe's close note records what was captured.
If nothing arrives before the first prompt, a bounded wait on the child's `spawn` event versus its `close` event is enough to distinguish alive from dead, which is all Pi's probe really settles.

## Done when

- A test in `src/server/adapters/claude/adapter.test.ts` starts the adapter against a process whose spawn fails, and asserts `start()` rejects; it fails before the change.
- A session-manager-level test, or an extension of the existing "teardown racing a startup" cases in `src/server/http/session-manager.test.ts`, shows the failed Claude startup leaves nothing in the session table.

## Close note

ClaudeAdapter now waits for the child process OS spawn event before start() resolves, so asynchronous direnv/sbox/ENOENT spawn failures reject startup and SessionManager unwinds without registering a live session. Added adapter-level and real-Claude-factory SessionManager regressions; both failed before the production change because start/attach resolved, then passed after it. Review added and verified disposal-during-spawn rejection while preserving the pre-existing asynchronous fork replacement contract. `bun run check` passed with clean typecheck/Svelte diagnostics and 967 tests.
