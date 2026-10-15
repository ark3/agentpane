---
labels: [change]
---

# Stop on Pi sends clear_queue before abort and hands every undelivered steered prompt back to the caller, on the HTTP API and the Emacs helper

Filed 2026-10-15 by OW-yewiku, which measured the problem and recorded the owner's decision in D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects").
The run is `docs/MANUAL_TESTING.md`, "A steer Stop catches before delivery is never answered, and where its text goes depends on what the turn was doing; `clear_queue` first takes it out cleanly (OW-yewiku)".

## What is wrong today

`PiAdapter.abort` in `src/server/adapters/pi/process.ts` sends a bare `{"type": "abort"}`.
On `pi 1.2.0`, a prompt `PiAdapter.submit` steered into a running turn and that Pi had not yet delivered is never answered after that abort, and where its text goes depends on what the turn was doing:
- Stopped mid-tool, the aborted run delivers it as a user message whose reply errors at once, so it stays in the transcript and in every later model call as a turn nobody answered.
- Stopped mid-reply, it stays queued and is delivered into the next prompt's run, after that prompt, and the one reply that follows answers neither cleanly.
The user saw a 202 for that prompt and pressed Stop; neither outcome is what they asked for.

## What the owner decided

Stop does what Pi's own interactive mode does with Esc: send `clear_queue` before `abort`, and give the text of every queued prompt back to the composer of the client that pressed Stop.
This card is the server and wire half; OW-yewiku filed one browser card and one `emacs` card blocked by this one, which put the text in each composer.
The adapter change and the wire land together here, so no build ever clears the queue without handing the text back.

## What Pi gives back

On `pi 1.2.0`, `clear_queue` answered, verbatim from the run:

    {"id": "clear", "type": "response", "command": "clear_queue", "success": true, "data": {"steering": ["YEWIKU-40A0BDA4 Reply with exactly the single word KILO and nothing else. Do not use tools."], "followUp": []}}

preceded by a `queue_update` with both queues empty.
Text only: a steered prompt's images are not returned, and that limit is Pi's, to be stated where the adapter reads the response, not worked around.
Pi's own `docs/rpc-commands.md`, section "clear_queue", documents the same `steering`/`followUp` arrays.
The adapter never sends `followUp`, but return both arrays' texts, steering first, because Pi may hold either.

## The change

- `PiAdapter.abort` sends `clear_queue`, then `abort`, and resolves with the cleared texts.
  The command and response unions in `src/server/adapters/pi/protocol.ts`, which `PiResponseFor` reads, carry `abort` and no `clear_queue` yet; add both arms there from the shape above, since Pi's packages are types-only (D10).
- `abort()` on the adapter contract in `src/server/adapters/types.ts` returns those texts, empty for Claude Code and Codex, whose adapters hold no queue of their own (Claude rejects mid-turn under D16, Codex delivers `turn/steer` at once).
- The abort route, `case "abort"` in `src/server/http/app.ts`, answers today with `noContent()`; it carries the texts in a body, with a response type in `src/shared/protocol.ts` beside `PromptResponse`, which is the precedent for a route that grew a body (OW-dulipe).
  `abort` in `src/client/api.ts` returns it.
- `sessions/abort` in `src/emacs/protocol.ts` answers `null` today (the method table and the docblock listing "`sessions/abort`, `sessions/compact` -- `{ session }` -> `null`"); its result carries the texts, and its handler in `src/emacs/helper.ts` passes them through.
- Only the caller gets the texts: the composer to refill is the one that pressed Stop, so this is the request's answer, not a broadcast event.

## Settle here, and record beside the code

- `compact()`: Pi's `compact` command begins with an abort of its own, so a steer queued at that moment meets the same fate.
  Decide whether `PiAdapter.compact` clears first and hands the text back too; whichever way, say why at `compact()`.
- The Pi abort `forkAndSubmit` sends ahead of a fork (`forkAndSubmit` in `src/client/controller.ts`, and the session-manager docblock's "the second abort `forkAndSubmit` sends ahead of a Pi fork (OW-relehi)"), and the Emacs client's own copy of that sequence (`sessions/abort` sent for the parent in `emacs/agentpane.el`).
  Whether Pi's steering queue survives a `fork` was not measured; decide what this path does with the texts this route now returns, and say so where the abort is sent.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, shown red first against today's `abort()`, asserts the commands `abort()` writes to Pi: `clear_queue` and then `abort`, in that order, and that `abort()` resolves with the texts the `clear_queue` response carried; and the same for `compact()` if the decision above covers it.
- A route test asserts the abort route's body carries the texts (`src/server/http/app.test.ts`, "aborts only an attached session", asserts today's 204), and `src/emacs/helper.test.ts`'s `sessions/abort` case (today asserting `null`) asserts the result carries them.
- `bun run check` passes.
