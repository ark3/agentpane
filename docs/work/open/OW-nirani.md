---
labels: [unverified]
---

# A Pi Stop during a tool call ends on an assistant message Pi marks as an error, and neither client has been shown to read it as a stop

Filed 2026-10-15 from OW-yewiku's run, where it surfaced beside what that card measured and is not that card's question.

## What the run showed

`docs/MANUAL_TESTING.md`, "A bare abort leaves an undelivered Pi steer unanswered in the transcript or inside the next prompt's run, by what the turn was doing; `clear_queue` first takes it out cleanly (OW-yewiku)", on `pi 1.2.0`, Pi alone on the home server.
An `abort` while a `bash` call ran ended the call with a `toolResult` reading `Command aborted` and `isError: true`, and then Pi opened one more round regardless of whether anything was queued, whose assistant message failed at once with `stopReason: "error"` and `errorMessage: "This operation was aborted"`.
The `clear_then_abort` tool cells show it with nothing queued, so every Stop during a Pi tool call ends that way, not only one that catches a steer.
An abort mid-reply instead ends the reply with `stopReason: "aborted"` and `errorMessage: "Request was aborted"`.
The cause, read at the same version: in `runLoop` in `pi-agent-core`'s `dist/agent-loop.js`, an aborted tool batch leaves `hasMoreToolCalls` true, so the loop streams one more assistant response on the already aborted signal.

## What nobody has checked

Whether either client shows the user who pressed Stop an error, where they expected a stop.
- Browser: `src/client/render/transcript.ts` keeps a banner for both `stopReason: "error"` and `"aborted"` (the `const banner` line); what the banner says for each is in the render components under `src/client/render/` and `src/client/`.
- Emacs: `src/emacs/nodes.ts` (the `turn.stopReason === "error" || turn.stopReason === "aborted"` branch) carries `errorMessage` only for `"error"`; `emacs/agentpane.el` draws it.
- The Pi reducer in `src/server/adapters/pi/reducer.ts` passes the message through; whether anything raises a session error from it is part of the check.

## Done when

A test in each client, built from a transcript shaped like the run (a `toolResult` with `isError: true` and `Command aborted`, then an assistant message with no content, `stopReason: "error"` and `errorMessage: "This operation was aborted"`), asserts what that client shows, and the result is recorded in this card's close note.
If either client shows it as an error the user did not cause, that is a `defect` card filed from this one, naming what it should show instead; if both read as a stop, this card closes `--done` on those tests.
