---
labels: [defect]
closed: done
---

# A Codex subagent rollout from 0.153.0 through 0.154.0 that takes the preview's item path no longer shows the parent messages it copied inline, which the preview drew before OW-luvema

Filed 2026-10-01 from the adversarial read of OW-luvema, which measured it over the home server's `~/.codex/sessions` (read-only).

## What changed

OW-luvema has the preview draw a Codex rollout from its `item_completed` records through live `mapItem`, choosing per file in `projectRollout` in `src/server/sessions/codex.ts`; `extractStoreTurn`'s docblock states the rule and the counts.
The item path draws only item records, so `response_item` content that has no record is not drawn at all.
A subagent written by `codex-cli` 0.153.0 through 0.154.0 copies some of its parent's `response_item` messages inline, its parent's prompt among them, and none of the parent's item records.
The 10 such subagents that also store `collaboration` function calls take the fallback and draw that copy as before; of the other 22, 17 lose at least one copied parent user message the preview drew before OW-luvema (7 on 0.153.0, 8 on 0.153.4, 2 on 0.154.0), and such a preview can open on an assistant reply with no prompt above it.
Example: the rollout whose name contains `01a08935` under `~/.codex/sessions/2026/09/09/`.
`historyBase`'s docblock carries the same counts.

The test that pins today's behaviour is "draws a subagent's rollout from its own item records, neither following its parent nor drawing what it copied" in `src/server/sessions/preview.test.ts`, which asserts only the subagent's own reply is drawn; it asserts what the code does, not a decision that this is right.

## The same mechanism, not yet seen

A single rollout holding some turns with item records and some without (a thread resumed into the same file after a Codex upgrade, or by a client that writes no records, as `codex_cli_rs` for vscode did on 0.150.1) would lose its record-less turns the same way.
The adversarial read found none among the 119 rollouts on 2026-10-01, and whether a resume appends to the same file was not measured.

## What is undecided

Whether the copied parent messages belong in a subagent's preview at all is the first question, and the answer is what attaching live to the same subagent thread shows: the preview's aim since OW-luvema is to match live.
Measure that first, on a real 0.153.x subagent thread, on the home server with `codex -m gpt-5.6-luna`, naming the version, and record it in `docs/MANUAL_TESTING.md`.

## Done when

- The live measurement is recorded in `docs/MANUAL_TESTING.md`.
- Whatever it shows, the "draws a subagent's rollout from its own item records, neither following its parent nor drawing what it copied" test in `src/server/sessions/preview.test.ts` asserts the preview matches it, and the comment beside that assertion cites the measurement; where that changes the preview, the test went red first.
- `historyBase`'s docblock no longer describes the loss as unexplained.

## Close note

Measured live on the home server 2026-10-01 on codex-cli 0.157.1 against subagent rollouts written by 0.153.0, 0.153.4 and 0.154.0, each in a throwaway CODEX_HOME: loaded through its parent, a subagent's thread holds only its own reasoning, agentMessage and commandExecution items and no userMessage, so neither the copied parent prompts nor its own task appear live; agentpane's hydrate of those turns and the preview agreed at every position (16/16, 25/25, 16/16).
So the preview leaving out the copied parent messages matches live, and the code stays as OW-luvema left it.
Recorded in docs/MANUAL_TESTING.md, "A Codex subagent's live thread holds none of the parent messages its rollout copies (OW-hagito)"; the preview.test.ts test "draws a subagent's rollout from its own item records, neither following its parent nor drawing what it copied" now cites it and was watched red by forcing projectRollout onto its response_item fallback; historyBase's docblock says the loss matches live.
The dispatching session reproduced the resume refusal, the empty thread/read and the through-parent item counts independently.
The run found that a plain thread/resume of such a subagent is refused on 0.157.1 ("resume the parent first"), so attaching one from the picker fails; filed as OW-filasi.
