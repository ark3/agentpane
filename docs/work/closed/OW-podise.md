---
labels: [defect]
closed: done
---

# A Pi Stop during an auto-retry shows in both clients as an adapter error reading Retry cancelled

Filed 2026-10-15 from OW-kibabi's adversarial review, which found it in Pi's source; nobody has seen it live.
In service of the same user OW-kibabi served: a person who pressed Stop should see that they stopped the turn, not an error they did not cause.

## What happens

Read in the installed `pi 1.2.0` (`pi --version`; source under `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`), not measured:
`AgentSession.abort` sets `_agentRunAbortRequested` and calls `abortRetry`, and on the way out of the run `_handlePostAgentRun` and the `finally` in the run loop call `_finishCancelledRetry`.
Whenever `_retryAttempt` is above zero, that emits `auto_retry_end` with `success: false` and `finalError: "Retry cancelled"`.
So a Stop pressed while Pi waits out a retry's backoff, or while the retried request runs, ends this way.

agentpane's `reducePiNotification` in `src/server/adapters/pi/reducer.ts`, `case "auto_retry_end"`, turns any unsuccessful end into an adapter `error` carrying `finalError`, which both clients show as a session error.

OW-kibabi fixed the sibling case, a Stop during a tool call, with `asPiStop` in the same file; read its docblock for how the transcript side was settled.
This case is not a transcript message, so `asPiStop` does not reach it.

## Load-bearing constraints

- One owner for both clients, server-side, as in OW-kibabi: `AGENTS.md`, "Both clients".
- A retry that gave up on its own (`success: false` with the provider's last error) must still surface as an error.
- The live adapter knows when it sent `abort` (`PiAdapter` in `src/server/adapters/pi/process.ts`), and the event's own text distinguishes the case too; whichever the fix keys on, name the version that text was read at.
- Triggering a retry live needs a retryable provider failure, so a fixture may have to be hand-built from the source reading; if so, say so beside it, as OW-nirani's fixtures did.

## Done when

A reducer or adapter test feeding `auto_retry_end` with `success: false, finalError: "Retry cancelled"` after a Stop shows no adapter error is raised, seen red before the fix and green after.
A test shows an `auto_retry_end` with `success: false` and a provider error, with no Stop, still raises the error.

## Close note

Built: `reducePiNotification`'s `case "auto_retry_end"` in `src/server/adapters/pi/reducer.ts` no longer raises an adapter error when `finalError` is `"Retry cancelled"`; any other unsuccessful end still raises `finalError` (commit "server: raise no adapter error for a Pi Stop during an auto-retry (OW-podise)").
Keyed on the event's text, not on the adapter's own Stop: read in the installed `pi 1.2.0`, not measured, only `AgentSession._finishCancelledRetry` sends that text, and only after `abort()` or the `abort_retry` RPC — a Stop, Pi's `compact`, a fork or session switch (`teardownCurrent`), or an extension's `abort` — while a retry that gives up sends the provider's last `errorMessage`. That needs no adapter state carried across the backoff.
`dispose` also cancels a retry but empties `_eventListeners` before the event could go out, so it never reaches agentpane.
A Stop while the retried request is in flight usually ends the retry with `success: true` instead, because the aborted reply's `stopReason` is `"aborted"`; that case never raised an error.

Verified: new test "raises no adapter error for a Stop during an auto-retry (OW-podise)" in `src/server/adapters/pi/reducer.test.ts`, with a fixture hand-built from the source reading because a live retry needs a retryable provider failure. It went red with the condition removed (1 failed, 37 passed) and green with it (38/38). The existing "auto_retry_end with success:false surfaces finalError" still covers a give-up with no Stop. `bun run check` passed: svelte-check 0 errors, 1742/1742 tests.

The adversarial review found that after a Stop in the backoff, the failed attempt's `stopReason: "error"` turn stays in the live transcript as a provider error, with no stop marker, while `get_messages` drops it. That is filed as OW-nevezo.
