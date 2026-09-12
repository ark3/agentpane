---
labels: [unverified]
closed: done
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

## Close note

Measured on the home server 2026-09-11, `claude 2.1.268`, explicit `--model haiku`.
`docs/MANUAL_TESTING.md` carries the section, "A mid-stream fork on Claude Code loses the partial reply, but only because agentpane kills the process (OW-japuzo)"; the run is reproducible with `python3 resources/probes/claude_fork_probe.py`, a new probe written for this rather than a third `--backend` in `fork_probe.py` — Claude Code has no RPC surface for a fork at all, so nothing in that file's JSON-RPC session classes applied.

**Both measurements came out, and both went against the adapter.**

*Is the partial on disk when we kill it?* No, at any point in the turn.
The `kill` cell reads the parent's store at four marks across the reply and kills at the last; the file was byte-identical at all four, 41 through 160 text deltas and 230 through 1163 characters, the last about 78% of the 1491-character reply.
The only lines gained were the prompt going in — two `queue-operation`, one `user`, one `attachment`.
The `fork` cell closes the rest of the span within one run: byte-identical at the parent's `result`, then two lines gained once the writer quiesced, an `assistant:thinking` and an `assistant:text` of the whole 1491-character answer.
So on 2.1.268 the assistant message reaches `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` only at the end of the turn and strictly after the wire says the turn is over, and agentpane's abort loses all of it.

*Can the parent turn survive?* Yes.
Spawned as a second child rather than replacing the first, the fork came up, adopted the session id it was given, answered its own prompt with `result` success and has its own store — while the parent emitted 160 further deltas, settled `success` with `is_error: false`, and wrote its whole reply durably.
Two `claude` children with live turns overlapped on one workspace, one resuming the other's store file mid-write, neither erroring.
What ends the turn today is `replaceProcess`'s `await previous.proc.kill()`, not the CLI.

**For D15: Claude sits on Codex's side of the line, and the uniformity argument is harder than it was.**
The split D15 fears is now one backend against two rather than one against one, and the abort costs more on Claude than the Codex run made it look — D15 can say of Codex that the reply landed anyway, and on Claude it does not.
Where the likeness stops is the shape: Codex survives by construction (one app-server process, many threads, nothing to kill), where Claude would survive only by running two children at once — which the CLI plainly allows and the adapter is not written for.
`Ownership` is a single nullable field, `replaceProcess` a swap over it, one `controlNamespace` and one `pendingControls` per adapter rejected wholesale on fork, and `SessionManager.fork`'s docblock has Claude on Pi's `#adoptRef` path where a surviving-parent fork would need Codex's.
Whether that is a small change or a real refactor is left open, deliberately; this run only removes the reason to assume the backend forbids it.
D15 is untouched, as the card required — `OW-ziyobe` takes that decision and the section names it as the vehicle.

**Note for whoever picks up OW-ziyobe:** that card is framed as a Codex-only question ("Whether agentpane should stop aborting a streaming *Codex* turn before forking"), and it was filed before this evidence existed. It is now a three-backend question with three different shapes, and the Claude case is the one that costs an adapter refactor. Widening it is the owner's call.

**How it was built.** One implementer in a worktree, one adversarial reader at the finished work, three rounds of correction — the reader's findings are why this note can be trusted, and two of them were load-bearing. The first draft's sharpest sentence rested on a cross-run comparison of two sessions never measured at the same point; the re-run replaced it with a within-run double read. And the cell's `"unearned"` gate covered the wire but not the disk, so an unresolved store path would have produced the identical absence to the headline finding and exited zero. Both are fixed in the committed probe. The same two gaps exist in `fork_probe.py`'s `codex_fork_mid_stream`, filed as **OW-wifibe**.

Also checked live rather than inferred: `--tools ""` on 2.1.268 strips the built-in tools (the model reports no `Bash` available) but not MCP tools, which `init.tools` still lists — so these records are sensitive to the operator's MCP configuration, and the section says so.

Landed on `main` as 85f0438, 6e32aa9, 5d0df8b, 01b0d4c, 035e072, 24db2de. Docs and probe only; nothing under `src/`, so `bun run check` does not gate them.
