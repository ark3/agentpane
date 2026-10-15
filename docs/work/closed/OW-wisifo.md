---
labels: [change]
closed: done
---

# Stop on Pi sends clear_queue before abort and hands every undelivered steered prompt back to the caller, on the HTTP API and the Emacs helper

Filed 2026-10-15 by OW-yewiku, which measured the problem and recorded the owner's decision in D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects").
The run is `docs/MANUAL_TESTING.md`, "A bare abort leaves an undelivered Pi steer unanswered in the transcript or inside the next prompt's run, by what the turn was doing; `clear_queue` first takes it out cleanly (OW-yewiku)".

## What is wrong today

`PiAdapter.abort` in `src/server/adapters/pi/process.ts` sends a bare `{"type": "abort"}`.
On `pi 1.2.0`, a prompt `PiAdapter.submit` steered into a running turn and that Pi had not yet delivered is not answered as the user sent it after that abort, and where its text goes depends on what the turn was doing:
- Stopped mid-tool, the aborted run delivers it as a user message whose reply errors at once, so it stays in the session's messages as a turn nobody answered.
- Stopped mid-reply, it stays queued and is delivered into the next prompt's run, after that prompt, and that run's one reply answered the steer, or went back to the interrupted reply, but never the new prompt.
The user saw a 202 for that prompt and pressed Stop; neither outcome is what they asked for.

## What the owner decided

Stop does what Pi's own interactive mode does with Esc: send `clear_queue` before `abort`, and give the text of every queued prompt back to the composer of the client that pressed Stop.
This card is the server and wire half; OW-yewiku filed OW-fahoti for the browser and OW-seleri for Emacs, both blocked by this one, which put the text in each composer.
The adapter change and the wire land together here, but the clients ignore the answer until their cards land: `abort()` in `src/client/controller.ts` discards what `api.abort` returns, and `agentpane-abort` in `emacs/agentpane.el` hands it to `#'ignore`.
So a build carrying this card alone clears the queue and shows the text nowhere, which is worse than today; D16 records that the three are run together, `card run OW-wisifo OW-fahoti OW-seleri`.

## What Pi gives back

On `pi 1.2.0`, `clear_queue` answered, verbatim from the run:

    {"id": "clear", "type": "response", "command": "clear_queue", "success": true, "data": {"steering": ["YEWIKU-40A0BDA4 Reply with exactly the single word KILO and nothing else. Do not use tools."], "followUp": []}}

preceded by a `queue_update` with both queues empty.
Text only: a steered prompt's images are not returned, and that limit is Pi's, to be stated where the adapter reads the response, not worked around.
And it is the text Pi queued, which as of `pi 1.2.0` is after its own expansion: `AgentSession.prompt` in `dist/core/agent-session.js` queues `expandedText`, the output of input handlers, `_expandSkillCommand` and `expandPromptTemplate`, so a steered `/skill:...` comes back as the expanded block, not as typed.
Say that where the adapter reads the response too.
Pi's own `docs/rpc-commands.md`, section "clear_queue", documents the same `steering`/`followUp` arrays.
The adapter never sends `followUp`, but return both arrays' texts, steering first, because Pi may hold either.

## The change

- `PiAdapter.abort` sends `clear_queue`, then `abort`, and resolves with the cleared texts.
  The command and response unions in `src/server/adapters/pi/protocol.ts`, which `PiResponseFor` reads, carry `abort` and no `clear_queue` yet; add both arms there from the shape above, since Pi's packages are types-only (D10).
- `abort()` on the adapter contract in `src/server/adapters/types.ts` returns those texts, empty for Claude Code and Codex, whose adapters hold no queue of their own (Claude rejects mid-turn under D16; Codex sends `turn/steer` straight to app-server, and what app-server does with a steer it has not consumed when `turn/interrupt` arrives was never measured, which is OW-pefawi's ground, not this card's).
- The abort route, `case "abort"` in `src/server/http/app.ts`, answers today with `noContent()`; it carries the texts in a body, with a response type in `src/shared/protocol.ts` beside `PromptResponse`, which is the precedent for a route that grew a body (OW-dulipe).
  `abort` in `src/client/api.ts` returns it.
- `sessions/abort` in `src/emacs/protocol.ts` answers `null` today (the method table and the docblock listing "`sessions/abort`, `sessions/compact` -- `{ session }` -> `null`"); its result carries the texts, and its handler in `src/emacs/helper.ts` passes them through.
- Only the caller gets the texts: the composer to refill is the one that pressed Stop, so this is the request's answer, not a broadcast event.

## Settle here, and record beside the code

- `compact()`: as of `pi 1.2.0`, `AgentSession.compact` begins with `await this.abort()`, so by that reading, not measured, a steer queued at that moment meets the same fate.
  Decide whether `PiAdapter.compact` clears first and hands the text back too; whichever way, say why at `compact()`.
- The Pi abort `forkAndSubmit` sends ahead of a fork (`forkAndSubmit` in `src/client/controller.ts`, and the session-manager docblock's "the second abort `forkAndSubmit` sends ahead of a Pi fork (OW-relehi)"), and the Emacs client's own copy of that sequence (`sessions/abort` sent for the parent in `emacs/agentpane.el`).
  Whether Pi's steering queue survives a `fork` was not measured; decide what this path does with the texts this route now returns, and say so where the abort is sent.
  The "Stop and edit" callers are the client cards' (OW-fahoti, OW-seleri), since there the text goes to a composer already holding the edit.
- A prompt posted after Stop but before Pi settles: Pi is still streaming, so `PiAdapter.submit` steers it into a queue `clear_queue` has already emptied, and what the abort then does with it was not measured.
  Decide whether that window needs anything, and say so at `PiAdapter.abort`.
- The return shape.
  The adapter fake `FakeAdapter.abort` in `src/server/http/testing/fakes.ts` and the many `AgentpaneApi` fakes in `src/client/*.test.ts` and `e2e/` (`abort: async () => {}`) are what a changed signature touches; `prompt`'s `Promise<PromptResponse | void>` in `src/client/api.ts` is the precedent for a route that grew a body without breaking those.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, shown red first against today's `abort()`, asserts the commands `abort()` writes to Pi: `clear_queue` and then `abort`, in that order, and that `abort()` resolves with the texts the `clear_queue` response carried; and the same for `compact()` if the decision above covers it.
- A route test asserts the abort route's body carries the texts (`src/server/http/app.test.ts`, "aborts only an attached session", asserts today's 204), and `src/emacs/helper.test.ts`'s `sessions/abort` case (today asserting `null`) asserts the result carries them.
- Each decision under "Settle here" is a comment at the site it names -- `PiAdapter.compact`, the abort ahead of a Pi fork in `forkAndSubmit`, and `PiAdapter.abort` for the after-Stop window -- and any of them that changes behaviour has its own test, red first.
- `bun run check` passes.

## Close note

Landed on main in 5be0158c, e74dd634, 7adb0d72 and 6421d62c.
`PiAdapter.abort` now sends `clear_queue`, waits for its answer, then `abort`, and resolves with the cleared texts, steering then followUp; the docblock states that only text comes back and that a steered skill or template comes back as Pi expanded it (`pi 1.2.0`, read at the source).
`BackendAdapter.abort()` returns `string[]`, empty from Claude Code and Codex.
The abort route answers 200 with `AbortResponse` (`{ queued }`, `src/shared/protocol.ts`) only when something was cleared and 204 otherwise, following `PromptResponse`, so `api.abort` resolves `AbortResponse | void` and no client fake changed; `sessions/abort` returns `AbortResponse | null`.
The texts go only to the caller, never on the event stream.
Decisions, each commented at its site and summarised in D16: `PiAdapter.compact` does not clear (no wire carries texts back from compact); the abort ahead of a Pi fork in `forkAndSubmit` and `agentpane--fork-points` drops what it clears, which loses those words; `PiAdapter.submit` refuses a prompt while a stop is awaiting Pi (a `stopsInFlight` counter), a behaviour change with its own tests.
Verified: new tests in `pi/process.test.ts`, `http/app.test.ts`, `client/api.test.ts` and `emacs/helper.test.ts`, each shown red against the old code by the implementer and checked by an adversarial reader; `bun run check` green (1692 tests).
The adversarial read found the counter misses a `prompt` already on Pi's stdin when `clear_queue` goes out; filed as OW-jifibo, which replaces the counter.
OW-fahoti and OW-seleri were amended with the landed shape and decisions.
