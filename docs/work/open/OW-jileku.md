---
labels: [unverified]
---

# A Pi compaction holds its session's mutation queue until it ends, and whether a Pi compact sent mid-turn waits for the turn is unmeasured

Filed 2026-09-24 by the execution of OW-sewewe, from its implementer's and its adversarial reader's reports.
In service of D24's serialisation commitment holding as written: the queue orders admission only, and nothing queued waits behind a running turn.

## What is known

OW-sewewe put `compact` in the per-session queue in `src/server/http/session-manager.ts` (`#serially`, and `SessionManager.compact`), so a queued verb starts only once the one ahead of it settles.
`PiAdapter.compact` in `src/server/adapters/pi/process.ts` settles on Pi's `compact` response.
As of `pi 0.84.2`, that response arrives only after `compaction_end`: see `resources/fixtures/pi/compact.jsonl`, where the response line follows the `compaction_end` event.
So on Pi a prompt, set-model, set-effort, fork or reply sent during a compaction waits until the compaction is done, which can be tens of seconds.
Codex and Claude Code answer `compact` at once, per the reader's reading of their adapters; that was not run live.
`#serially`'s docblock records the Pi hold.

## What nobody has measured

What Pi does with a `compact` sent while a turn is streaming.
If it waits for the turn to end before compacting, then everything queued behind that compact waits behind a running turn, which D24 and OW-rifezo rule out.
The browser's Compact button stays enabled while a Pi turn streams: in `src/client/App.svelte` it is gated only on the session's `compaction` state.
Whether `pi 0.85.1` still answers after `compaction_end` is unmeasured too.

A related exposure, incidental here: no adapter puts a timeout on its backend requests (Pi's `sendCommand`, Claude Code's `sendControl` in `src/server/adapters/claude/adapter.ts`, Codex's `client.request`).
Since OW-sewewe, one request that never settles holds every later queued verb on that session, not only its own HTTP request, and only `close` clears it.

## Done when

- A live run on the home server with `pi --model openrouter/deepseek/deepseek-v4.1-flash:high`, recorded in `docs/MANUAL_TESTING.md` under a heading naming this card and the `pi` version, answers two things: when Pi's `compact` response arrives relative to `compaction_start` and `compaction_end`, and what Pi does with `compact` sent mid-turn: whether it answers before the turn ends, waits for it, or refuses.
- The decision on whether `PiAdapter.compact` keeps settling on Pi's response or settles earlier, so the queue admits the next verb once the compaction has started, is recorded in `#serially`'s docblock with the measurement it rests on, whichever way it goes.
  If it changes, a test in `src/server/adapters/pi/process.test.ts` shows `compact` settling at the new point, red first.
