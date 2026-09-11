---
labels: [unverified]
closed: done
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

## Close note

Run, and the answer is the surprising one: **Codex's parent turn survives a mid-stream `thread/fork`.** It keeps streaming, settles normally, and its whole reply lands on disk. That is the opposite of Pi, and it is the evidence D15 named as the one thing that would reopen its decision.

The run: home server, 2026-09-11, `codex-cli 0.154.0`, model `gpt-5.6-luna`, a new `codex_fork_mid_stream` cell in `resources/probes/fork_probe.py`, written up in `docs/MANUAL_TESTING.md` under "Forking a Codex thread mid-stream leaves the parent turn running (OW-gojado)", beside the OW-yudoni Pi result as this card asked.

Streaming was confirmed rather than assumed, which was the cell's hardest part. It waits for two independent signals on the parent's own `threadId` — a `turn/started` notification and at least five `item/agentMessage/delta`s accumulating, with no `turn/completed` between — and records `result: "unearned"` and exits non-zero if it cannot get both. A fork fired at a turn that had already settled measures nothing and fails silently, which is the failure this guard exists for.

What happened: the fork returned a new thread id mid-stream; `thread/read` on it succeeded and its rollout was on disk carrying `forked_from_id` naming the parent. After the fork call the parent emitted at least 300 more deltas — a floor, since the mark is taken after the fork response returns — and then `turn/completed` with `status: "completed"` and `error: null`. The parent's rollout, sha256'd immediately before the fork request and again after the parent settled, went from 21 lines to 26 and gained the complete 1491-character reply, `1\n2\n3\n…` through `…398\n399\n400`. D15 named `codex_new_session`'s `parent_untouched` as too weak for this — it reads only the parent header's `forked_from_id` — so the cell hashes the file and reads what it gained, and `parent_untouched`'s own line now carries a note saying what it can and cannot answer.

Two things the run does not establish, both stated in the write-up rather than leaned on: it measured one thread on one model, and it drove no turn inside the fork. A third thing that looked like a gap is not one — the cell forked through the turn *before* the streaming one, which is what `ThreadForkParams` requires ("The referenced turn cannot be in progress") and exactly what `fork()` in `codex/adapter.ts` computes, so the cell measured what production does and the alternative is not expressible.

One incidental finding worth having: **the Codex rollout's line shape changed between 0.147.0 and 0.154.0.** The committed `resources/fixtures/codex/fork.jsonl` writes every reply twice, as an `event_msg` with `payload.type: "agent_message"` and again as a `response_item` `message` with `role: "assistant"`. On 0.154.0 the `agent_message` event is gone, replaced by `event_msg`/`item_completed`, and a `token_usage_record` line type appears that the fixture does not have. This surfaced because a reviewer counted the fixture and asked why one assistant line landed where two were expected. The cell now records a census of every rollout line the parent gained, so the next reader sees a shape change instead of inferring one from a count — which matters because the cell deletes its `CODEX_HOME` and that census is the only artifact that survives.

D15 was rewritten, and the rewrite did more than record the finding. Its heading is now "agentpane stops a streaming turn before forking it, on every backend", because the old one asserted as fact the thing this run refuted. And the second reason it used to give — that a surviving turn streams into a session nobody is looking at, tokens spent to produce an orphan — is the part this run weakened: the reply is durable, the parent is a session agentpane lists and the user can navigate back to, and the tokens are spent either way since the abort lands after the model has produced most of the reply. D15 now says that and rests on uniformity across backends alone. The same weakened reason had been copied into `forkAndSubmit`'s comment in `src/client/controller.ts` and was corrected there too. No behaviour changed; `forkAndSubmit` is untouched.

This card's conditional is discharged as `OW-ziyobe`: whether to take the asymmetry after all, now that the decision rests on one argument where it used to rest on two. It carries the addresses — `forkAndSubmit`, `sendLabel`, the "Stop and edit" affordance, and the tests that pin those labels by name.

Also retired, with a scope word rather than a correction: `docs/HANDOFF.md` finding 45 and the OW-mewiga section in `docs/MANUAL_TESTING.md` both said "the parent rollout is untouched", which remains true of the fork but reads as a general property; they now say the fork writes nothing to the parent rollout and note that a mid-stream parent keeps writing its own turn. A review round had reported those as facts this run falsified; they are not — the mid-stream parent's rollout grew from its own turn, not from the fork.

Two review rounds ran before this landed. The first caught a line-counting bug that would have silently misattributed rollout content (lines counted with `bytes.splitlines()` and then indexed into a `str.splitlines()` list, which disagree on U+2028/U+2029 — the exact hazard this probe's own docstring names), a false justification in the probes README for writing no fixture, a committed doc pointing at a volatile `/var/tmp` path, the unreconciled assistant-line count above, and the D15 justification problem. `bun run check` passes, 1014 tests; the `src/` change is comment-only. Landed on `main` as fb3b77b..51b30e1.
