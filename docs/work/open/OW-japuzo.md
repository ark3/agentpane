---
labels: [unverified]
---

# Nobody has measured what a mid-stream fork does to a Claude Code parent turn, and D15 decides for three backends on evidence from two

Filed 2026-09-11 from the OW-ziyobe discussion, which is blocked on this.

`docs/DESIGN.md` D15 is headed "agentpane stops a streaming turn before forking it, on every backend" and its body reasons about Pi and Codex only.
Claude Code is not mentioned once.
The abort is client-side and backend-agnostic (`src/client/controller.ts` `forkAndSubmit`, the `isStreaming` check), so it applies to Claude too, and no run has ever looked at what it costs there.

This matters to the decision, not just to the record.
D15's remaining argument is uniformity: "Pi cannot be brought to match, so the alternative is a permanent split."
That is one backend holding the line if Claude behaves like Codex, and two if it behaves like Pi, and the two cases weigh differently.

## Why Claude is not obviously Pi's case

Pi's loss is the CLI's: a mid-stream fork moves the live `sessionFile` and the in-flight turn is abandoned whatever the client does (`docs/MANUAL_TESTING.md`, OW-yudoni).

Claude's loss is ours.
`src/server/adapters/claude/adapter.ts` `fork()` calls `replaceProcess`, whose first acts are `previous.live = false`, rejecting the pending controls, and `await previous.proc.kill()`, before respawning on `--resume <id> --resume-session-at <entryId> --fork-session`.
One adapter, one child.
The in-flight turn dies because agentpane kills the process hosting it, and nothing about Claude Code's own behaviour was consulted to arrive at that.

Codex avoids this by construction rather than by choice: one app-server process hosts many threads, so `thread/fork` mints a thread beside the parent and there is nothing to kill.

## The two measurements

**Is the parent's partial reply already on disk when we kill it?**
This is the cheaper question and it is worth having on its own.
The adapter's docblock records that "the parent's store file is untouched and turns up in listings as a detached session" (OW-mayuza), and `readStore` reads `~/.claude/projects/<munged-cwd>/<session-id>.jsonl`.
If Claude Code flushes assistant text to that file as it streams, then today's abort loses less than it appears to, and the answer may be that Claude needs no change at all.
If the file gains nothing until the turn ends, the loss is total and matches Pi's in effect if not in cause.
Hash or line-count the parent's store file immediately before the fork and again after, the way OW-gojado's cell hashes the Codex rollout — `docs/MANUAL_TESTING.md`, "Forking a Codex thread mid-stream leaves the parent turn running".

**Can the parent turn survive at all?**
Spawn the fork as a second child instead of replacing the first, and see whether the original process runs its turn to completion with its full reply landing in the parent's store.
This is a probe, not a change to `adapter.ts`: establish the behaviour before anyone decides whether the adapter should work that way.

## Confirm streaming rather than assuming it

OW-gojado's cell is the model and its discipline is the load-bearing part.
It waits for a positive `turn/started` plus five accumulated deltas on the parent before firing the fork, and records `result: "unearned"` and exits non-zero if either signal is missing, because sleeping cannot distinguish a surviving parent from a fork that landed after the turn had already finished — and that failure mode is silent.
Claude Code's stream-json equivalents are the signals to wait on; `src/server/adapters/claude/protocol.ts` and `reducer.ts` name what arrives.

`resources/probes/fork_probe.py` has no Claude path at all: its `--backend` choices are `("pi", "codex")` and there is no `run_claude`.
Adding a third backend there or writing a separate probe is the implementer's call; the existing file is the prior art either way.

## The open question this does not answer

Whether a second concurrent child is cheap in the adapter's lifecycle, or whether `Ownership`, the control channel and the session manager's `#adoptRef` re-keying assume one child per adapter hard enough that it is a real refactor.
Treat that as an open question to report on, not an assumption to design around.
The probe can spawn a second `claude` process directly without going through the adapter, which is the point of measuring before deciding.

## Done when

`docs/MANUAL_TESTING.md` carries a section, in the shape of the OW-gojado one, recording the run on the home server with the `claude` version and the explicit model, and answering both measurements above.
Whatever the answers, the section states what they mean for D15's uniformity argument — that Claude sits on Codex's side of the line, or on Pi's, or that the distinction does not survive contact.
Do not amend D15 here: OW-ziyobe is the card that takes that decision.

Home server, `claude --model haiku`.
Not `work-laptop`: no Pi involved.
