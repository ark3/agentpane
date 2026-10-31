---
labels: [defect]
closed: promoted
---

# After a Pi Stop during an auto-retry backoff, the failed attempt stays drawn as a provider error and nothing says the turn was stopped

Filed 2026-10-15 from OW-podise's adversarial review, which found it in Pi's source; nobody has seen it live.
In service of the user OW-podise and OW-kibabi served: a person who pressed Stop should see that they stopped the turn, not an error they did not cause.

## What happens

Read in the installed `pi 1.2.0` (`pi --version`; source under `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`), not measured.
A retryable failure arrives as `message_end` carrying an assistant message with `stopReason: "error"` and the provider's `errorMessage` (for example a 529 overloaded).
Pi then emits `turn_end`, `agent_end` with `willRetry: true`, and `auto_retry_start`, and sleeps out the backoff in `_prepareRetry`.
A Stop in that backoff ends the retry with `auto_retry_end` carrying `finalError: "Retry cancelled"`, which since OW-podise raises no adapter error, and then `agent_settled`; no new assistant message follows.
So the last thing in the live transcript is the failed attempt, still an error: `asPiStop` in `src/server/adapters/pi/reducer.ts` rewrites only an empty reply whose `errorMessage` is `"This operation was aborted"`, so the provider's error turn passes through it unchanged.
The browser draws it as the red error banner (`src/client/render/Message.svelte`, the `stopReason === "error"` branch), and the Emacs projection carries `stopReason` and `errorMessage` the same way (`src/emacs/nodes.ts`).
No "stopped" marker appears anywhere.
The same holds if the Stop lands after the failed attempt's `agent_end` but before `_handlePostAgentRun` starts the retry: `_retryAttempt` is still 0 there, so no retry events are sent at all.

Live and reloaded differ, which is part of the defect: `_omitRecoveryAttempt` in `agent-session.js` appends a context edit that drops the failed attempt from the model projection, and per the review `get_messages` in `modes/rpc/rpc-mode.js` returns that projection, so a session hydrated after the Stop does not show the failed attempt at all, while the live view keeps it.
The stored-file preview reads the raw session file, where Pi keeps the failed attempt "in raw history", so what it shows is a third reading to check.

## Load-bearing constraints

- The failed attempt was a real provider failure, and the same banner already shows during a backoff nobody stopped; whether it stays, goes, or is joined by a stop marker is the fix's decision, and it should make live, hydrated and preview agree.
- One owner for both clients, server-side, as in OW-kibabi and OW-podise: `AGENTS.md`, "Both clients".
- A retry that gave up on its own must still end with the provider's error visible.
- A live retry needs a retryable provider failure, so fixtures may have to be hand-built from the source reading; say so beside them, as OW-podise's test in `src/server/adapters/pi/reducer.test.ts` ("raises no adapter error for a Stop during an auto-retry (OW-podise)") does.
  That test's sequence omits `turn_start`, `turn_end` and `entry_appended`, which a transcript-level test should include.

## Done when

A reducer or adapter test replaying a Stop during the backoff (failed attempt, `agent_end` with `willRetry: true`, `auto_retry_start`, `auto_retry_end` "Retry cancelled", `agent_settled`) asserts the transcript the fix decides on, seen red before the fix and green after.
A test shows the live transcript and the one hydrated from `get_messages` for the same session agree on whether the failed attempt appears.

## Close note

Promoted to ark3/agentpane#11 during the card triage, 2026-10-31.
The owner wants the findings here measured again on current versions before any design; the issue opens with that re-measurement, then a design discussion, after which the work is split into fresh cards.
