---
labels: [defect]
---

# PiAdapter orders a stop after every prompt already on Pi's stdin, retiring the stopsInFlight refusal

Filed 2026-10-15 from the adversarial read of OW-wisifo, which landed Stop on Pi as `clear_queue` then `abort` (D16 in `docs/DESIGN.md`, "A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects").
This is the sibling the guard-at-the-site rule calls for (AGENTS.md, "Evidence"): OW-wisifo guarded the window between Stop and Pi's answer with a counter, `stopsInFlight` in `src/server/adapters/pi/process.ts`, which `PiAdapter.submit` checks to refuse a prompt while any `abort()` is awaiting Pi, and the read named cases that counter misses.

## The case the counter misses

A prompt whose `submit` passed the check before Stop, and whose `prompt` command is already written to Pi but not yet answered, when `abort()` writes `clear_queue`.
The prompt route goes through `SessionManager.#serially` in `src/server/http/session-manager.ts`, and the abort route reaches the adapter directly, deliberately (that file's "Left out, each for its own reason", `abort`), so nothing on the server orders the two.
Read at the installed `pi 1.2.0` package, not measured: in `dist/modes/rpc/rpc-mode.js`, `case "prompt"` starts `session.prompt(...)` without awaiting it, and `AgentSession.prompt` awaits `_runInputHandlers` (and `_tryExecuteExtensionCommand` for `/` text) before `_queueSteer` pushes the text; `case "clear_queue"` calls `session.clearQueue()` synchronously, and the JSONL reader hands every line of a chunk to `handleInputLine` in one synchronous loop.
So a `prompt` and a `clear_queue` arriving in one chunk clear first and queue after: `clear_queue` returns nothing, the steer is queued, the submitter gets 202, and the `abort` that follows strands it exactly as OW-yewiku measured a bare abort doing (`docs/MANUAL_TESTING.md`, "A bare abort leaves an undelivered Pi steer unanswered ... (OW-yewiku)").
The window is narrow on the home server, whose two Pi extensions register no `input` handler; an async one widens it.

## Two more the same change should settle

- `sendCommand` has no timeout, so if Pi never answers `abort` (its `AgentSession.abort` ends in `waitForIdle`), the counter stays up and every prompt on that session is refused with a 500 until the session closes; before OW-wisifo only the Stop request hung.
- If `clear_queue` succeeds and the `abort` after it fails, most realistically Pi dying between the two, the texts Pi already removed are thrown away with the rejection and exist nowhere.

## What to change

The ordering belongs to whatever owns the order of commands on Pi's stdin, which is `PiAdapter` (`sendCommand` and `pendingCommands`), not to a counter `submit` reads.
Have a stop send `clear_queue` only once every `prompt` command already written has been answered, since Pi answers a steered prompt `queued` only after `_queueSteer`, so its text is then in the queue `clear_queue` empties.
Decide whether a prompt arriving while the stop is in flight waits for the stop and then starts a fresh turn on an idle Pi (Pi's `abort` answers after `agent_settled` on `pi 1.2.0`), or is still refused; waiting is what a user who pressed Stop then Send expects, and refusing is what OW-wisifo chose only because the counter could not do better.
Say at `PiAdapter.abort` what happens to the texts when the `abort` after a successful `clear_queue` fails.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, red first against the landed `abort()`, starts a `submit` whose `prompt` is unanswered, calls `abort()`, and asserts `clear_queue` is not written until that `prompt` is answered, and that `abort()` then resolves with the texts the `clear_queue` response carried.
- The `stopsInFlight` counter and the `STOP_IN_FLIGHT_ERROR` refusal are gone from `src/server/adapters/pi/process.ts`, or, if the decision above keeps a refusal, it is expressed through the same ordering and not a second counter; the two existing tests in `describe("PiAdapter stop (D16, OW-wisifo)")` are rewritten to the decision.
- The comment on `PiAdapter.abort` names the decision and the failed-`abort` case, and `docs/DESIGN.md` D16's sentence "`PiAdapter.submit` refuses a prompt while a stop is awaiting Pi's answer" is updated to match, along with the same sentence in OW-fahoti and OW-seleri if they are still open.
- `bun run check` passes.
