---
labels: [deferral]
---

# Codex drops the first line of a long-running command output from the wire, so the live transcript starts at line two while the rollout keeps line one

Seen 2026-09-30 in `resources/fixtures/codex/long-shell.jsonl`, captured on `codex-cli 0.157.1` with `gpt-5.6-luna` by OW-zadupu.

The command `for i in $(seq 1 45); do echo line-$i; sleep 1; done` ran long enough to be polled with `write_stdin`.
On the app-server stream the first `item/commandExecution/outputDelta` is `line-2`, and the `commandExecution` item's `aggregatedOutput` on `item/completed` also begins at `line-2`.
In the rollout of the same run, `long-shell.rollout.jsonl`, the raw `exec_command` script output holds `line-1`, but Codex's own `CommandExecution` `item_completed` record there also begins at `line-2`.

So the loss is upstream, in the item Codex builds, not in agentpane's mapping: the live transcript shows exactly what the wire carried.
It was not investigated whether it happens only when the command outlasts its `exec_command` yield, or on every streamed command.

Deferred because agentpane cannot restore a line the wire never sent, and one line of a long command's output is cheap to lose.
Revisit if a user reports missing first lines, or if a later Codex version changes it; the done condition then is a decision recorded here, with the version it was measured on, whether to read the line back from the rollout or report upstream.
