---
labels: [defect]
closed: done
---

# A Pi Stop during a tool call shows in both clients as an error carrying Pi's message, where a Stop mid-reply shows as aborted

Filed 2026-10-15 from OW-nirani, which pinned what each client shows today and found both read the Stop as an error the user did not cause.
In service of the user who pressed Stop seeing that they stopped the turn, the same way whether Pi was mid-reply or mid-tool.

## What happens

As of `pi 1.2.0`, an `abort` while a tool runs ends the call with a `toolResult` reading `Command aborted` with `isError: true`, and Pi then streams one more round on the already aborted signal, whose assistant message has no content, `stopReason: "error"` and `errorMessage: "This operation was aborted"` (`docs/MANUAL_TESTING.md`, "A bare abort leaves an undelivered Pi steer unanswered ... (OW-yewiku)"; the cause, read at that version, is `runLoop` in `pi-agent-core`'s `dist/agent-loop.js` leaving `hasMoreToolCalls` true after an aborted tool batch).
An abort mid-reply instead ends with `stopReason: "aborted"`.

What the clients show, pinned by OW-nirani's tests:
- Browser: the `{#if turn.stopReason === "error"}` branch in `src/client/render/Message.svelte` draws the red `banner error` reading `This operation was aborted`, kept in reading view; a mid-reply Stop draws the grey `banner aborted` reading `Aborted.`.
  Tests: `src/client/render/Transcript.svelte.test.ts`, `describe("a Pi Stop (OW-nirani)")`.
- Emacs: `metaFor` in `src/emacs/nodes.ts` sends `stopReason: "error"` with the `errorMessage`, and `agentpane--meta-text` in `emacs/agentpane.el` draws `error · This operation was aborted`; a mid-reply Stop reads `aborted`.
  Both are in `agentpane-warning`, so in Emacs only the words differ.
  Tests: `src/emacs/nodes.test.ts`, `describe("a Pi Stop (OW-nirani)")`, and `agentpane-test-pi-stop-during-a-tool-reads-as-an-error` in `emacs/agentpane-test.el` (ERT is not in `bun run check`: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`).
- Server: nothing raises a session error for it; `reducePiNotification` in `src/server/adapters/pi/reducer.ts` passes the message through (`reducer.test.ts`, "raises no adapter error for a Stop during a tool call").
  A reopened session shows the same, because `src/server/sessions/preview-message.ts` keeps `errorMessage`.

## What it should show

What a Stop mid-reply shows: the browser's `Aborted.` banner and Emacs's `aborted`, with no Pi error message, both live and in a reopened session.
The failed tool card keeps its error state; that call really did end early.

## Load-bearing constraints on the fix

- One owner for both clients.
  The "Both clients" rule in `AGENTS.md` asks for parity, and a server-side mapping that turns this message into `stopReason: "aborted"` before either wire carries it fixes both at once; two client-side recognisers would be two copies of one rule.
- It must cover the stored path as well as the live one.
  Live, the adapter knows it sent `abort` (Stop); a reopened session's store does not record that, so whatever recognises the message there has only the transcript.
- It must not turn a genuine provider failure into a quiet stop.
  An error turn after a failed tool call that the user did not stop must still read as an error.
- OW-nirani built its fixtures by hand: the OW-yewiku probe printed the errored message to the screen and saved nothing, so its `model` and `usage` fields were never captured.
  If the fix keys on anything beyond `stopReason`, `errorMessage` and empty `content`, capture a real one first and name the version.

Whether Pi should stop opening that extra round is upstream's to decide; this card is about what agentpane shows for it while Pi does.

## Done when

The OW-nirani tests named above are rewritten to assert the stop (`banner aborted` reading `Aborted.` in the browser, `stopReason: "aborted"` with no `errorMessage` from `metaFor`, `aborted` in the Emacs meta line), and each is seen red before the fix and green after.
A test on the stored path (`previewTurnsFromMessages` in `src/server/sessions/preview-message.ts`, or wherever the fix lives) shows a reopened session reads the same.
A test shows an error turn after a failed tool call with no Stop still renders as an error.

## Close note

Landed in 82772439 ("pi: send a Stop during a tool call as aborted, live, resumed and stored").
`asPiStop` in `src/server/adapters/pi/reducer.ts` rewrites an assistant message with `stopReason: "error"`, `errorMessage: "This operation was aborted"` and empty `content` to `stopReason: "aborted"` without the message.
It keys on nothing else, so no new capture was needed.
No single entry point is shared by all Pi messages, so the one helper is called at each of the three: the live reducer's `message_start` and `message_end`, `withLoadedEfforts` (resume and fork through `hydrateMessages`), and `extractPreviewTurn` in `src/server/sessions/pi.ts` (the stored preview; Pi does not go through `previewTurnsFromMessages`, which the card had named).
Both clients read the server's output, the Emacs helper through the HTTP API, so neither client changed.

Verified: with `asPiStop` stubbed to the identity, six tests went red (browser Stop-during-tool and reading view, `nodes.test.ts` `metaFor`, the reducer, the stored preview in `pi.test.ts`, the resume in `process.test.ts`) and all went green with it; a seventh pins the `message_start` site alone, since the update there is broadcast before `message_end`, and went red with that one call removed.
Guards that a provider error after a failed tool call with no Stop still reads as an error, and that an errored turn with content stays an error, sit in the reducer, preview and browser tests.
The ERT test is renamed `agentpane-test-pi-stop-during-a-tool-reads-as-aborted`; it pins how the meta line is drawn and cannot go red on a server-side fix, which `nodes.test.ts` covers instead.
`bun run check` passed (1714 tests), and ERT passed.

Adversarial review, read against the installed `pi 1.2.0` source: no path carries a Pi message to either wire without passing one of the three call sites.
The shape arises whenever a round is set up on an already aborted agent signal (`lazyStream` in `pi-ai`), so a `compact` or fork landing during a tool call, both of which abort first, also reads as a stop; the docblock says so.
The same review found a Stop during an auto-retry surfacing as the adapter error `Retry cancelled` by another channel, filed as OW-podise.
