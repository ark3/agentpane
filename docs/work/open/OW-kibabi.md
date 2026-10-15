---
labels: [defect]
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
