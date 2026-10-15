---
labels: [defect]
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
