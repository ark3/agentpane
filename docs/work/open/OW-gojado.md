---
labels: [unverified]
---

# Nobody has forked a Codex thread mid-stream, so D15 rests on an inference about whether the parent turn survives

`resources/probes/fork_probe.py`, `src/server/adapters/codex/adapter.ts` `fork`, `docs/MANUAL_TESTING.md` under "Observed fork-from-past" and "Settling the fork's returned ref".

D15 records that forking a streaming turn stops it on every backend, and it names this as the one thing that would reopen the decision.

The belief in question is that Codex's parent thread keeps streaming through a `thread/fork`.
It is a reasonable inference — `thread/fork` mints a new thread with its own `sessionId`, the parent rollout is byte-identical afterwards, and the adapter deliberately leaves its own `currentRef` and `threadId` on the parent (`adapter.ts` `fork`) — but every cell that established those facts forked an **idle** thread.
OW-mewiga drove a turn in the fork; OW-pifowo checked that the forked rollout is flushed before any turn.
Neither fired `thread/fork` while the parent was mid-turn, which is the only condition D15 turns on.
The Pi side of exactly this question *was* probed mid-stream, under OW-yudoni, and the answer was surprising: the fork succeeds and abandons the turn.
That is the reason not to assume Codex's answer.

This needs no work laptop.
Only Pi is confined there; `codex` runs on the home server, so this is a cheap probe that simply has not been run.

## Done when

`resources/probes/fork_probe.py` carries a cell that starts a Codex thread, drives a long turn, confirms it is streaming, fires `thread/fork`, and then records — from the parent thread, not from the fork — whether the turn continues, whether it settles, and whether any assistant text lands in the parent rollout after the fork call.
The observation goes to `docs/MANUAL_TESTING.md` beside the OW-yudoni Pi result, phrased over what was seen rather than over what was expected.

Then, whichever way it comes out: if the parent turn dies, D15's "what would reopen this" clause is retired and D15 records that both backends lose the turn as a matter of fact rather than of choice.
If the parent turn survives and produces something, that is the evidence D15 asked for, and whether to take the asymmetry after all is a question card of its own — file it rather than changing `forkAndSubmit` here.
