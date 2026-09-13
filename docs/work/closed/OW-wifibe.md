---
labels: [defect]
closed: done
---

# fork_probe.py's Codex mid-stream cell can report a measurement it did not earn, in two ways claude_fork_probe.py closed

Found on 2026-09-11 while executing OW-japuzo, whose probe took `codex_fork_mid_stream` as its model and then had to close two gaps in it that the Codex cell still has.
Neither gap is known to have corrupted the OW-gojado run; this is about what the cell can silently report next time, not about retracting anything.

`resources/probes/fork_probe.py`, the `codex_fork_mid_stream` cell, and `resources/probes/claude_fork_probe.py` for the shape of both fixes.

## 1. No re-check at the instant of the action

The cell's whole discipline is the refusal to confuse a surviving parent with a fork that landed after the turn had already finished.
It earns that by waiting for a positive `turn/started` plus five accumulated deltas — and then fires `thread/fork` straight off that wait's return, gating only on `streaming_confirmed`.
Nothing re-reads the buffer at the fork itself, so a turn that settles in the gap between the wait returning and the request going out is reported as a mid-stream fork.

That gap is not hypothetical: it is how the first run of `claude_fork_probe.py` killed a turn that had already finished, which is what put the check there.
`claude_fork_probe.py`'s `still_streaming(child, mark)` is the fix — one buffer read immediately before the action, recorded beside it, and gating the cell's `result` alongside the positive signal.

## 2. The "unearned" gate covers the wire and not the disk

`codex_fork_mid_stream` hashes the parent's rollout before the fork and after the parent settles, and that hash pair is what D15 now rests on for Codex.
But the cell's `result` reads only the streaming signals.
A rollout path the cell could not resolve, or a snapshot of a file that does not exist, produces "the file did not change" — and on a cell whose finding is about what the file *gained*, a file that was never found is indistinguishable from a file that gained nothing.

`claude_fork_probe.py` fails the cell with a non-zero exit on an unresolved store path, a baseline that does not exist, or a store whose already-written lines change under it (`prefix_preserved`).
The Codex cell wants the same three.

## Done when

`codex_fork_mid_stream` records a re-check at the instant of the fork request and gates its `result` on it, and its `result` also gates on the rollout having been resolved and read.
Shown by running the cell with the rollout path deliberately broken — a wrong glob, or a `CODEX_HOME` pointed somewhere empty — and watching it report `"unearned"` and exit non-zero where today it exits zero with an empty census.
That is the red-then-green: break it first and watch the current code pass.

Home server; needs `codex -m gpt-5.6-luna`, and a live run costs one long model turn per invocation.

## Close note

Both gaps closed in `resources/probes/fork_probe.py`'s `codex_fork_mid_stream` cell, landed as 000daad on main.

`CodexSession.still_streaming(mark, thread_id)` re-reads the buffer for a `turn/completed` immediately before the `thread/fork` request goes out, is recorded as `still_streaming_at_the_fork_itself`, and gates the cell's `result` beside `streaming_confirmed`.
`codex_rollout_snapshot` now returns `exists` and the byte-split `raw` lines (via `codex_rollout_lines`, not `str.splitlines`), which feed a `disk_read_earned` gate of the same three checks `claude_fork_probe.py` makes: rollout resolved, baseline on disk, `prefix_preserved`.
`main()` gates the process exit on the cell's own `result` rather than re-listing `streaming_confirmed_before_fork`, so a condition added to the cell reaches the exit code without a second edit.

Shown red-then-green live on the home server, 2026-09-13, `codex-cli 0.154.0`, with `codex_rollout_for`'s glob deliberately broken to `*.deliberately-broken`.
On the old code that break gave `result: "measured"`, exit 0, `parent_rollout_file: null`, `parent_rollout_lines_at_fork: 0` and an empty gained census — the silent failure the card named.
On the new code the same break gives `result: "unearned"`, `disk_read_earned: false`, `parent_rollout_resolved: false`, exit 1.
Unbroken it gives `result: "measured"`, `still_streaming_at_the_fork_itself: true`, `disk_read_earned: true`, the parent rollout resolved and going 21 -> 26 lines with one assistant `response_item` of 1491 chars, `parent_turn_status: "completed"`, exit 0.
The 0.154.0 finding the cell exists to carry — the parent survives a mid-stream fork and writes its whole reply — is unchanged and now earned.
The three run records are `/tmp/ow-wifibe-{red,green,healthy}.log`, which do not survive the machine; the numbers above and the commit message carry what they showed.

The claim that these two gaps were still open lived in four places and all four were retired in the same commit: `fork_probe.py`'s module docstring, `claude_fork_probe.py`'s module docstring and its `still_streaming` docstring, `resources/probes/README.md` (the mid-stream bullet, the exit-code sentence, and the `claude_fork_probe.py` section), and `docs/MANUAL_TESTING.md`'s "Streaming was confirmed before each action" paragraph, where the sentence was redated to the run rather than deleted.

Nothing under `src/` was touched, so `bun run check` is not implicated.
