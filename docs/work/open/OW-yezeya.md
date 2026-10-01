---
labels: [defect]
---

# fork_probe.py and pi_rpc_probe.sh still take their model from the mutable settings files, not from the pin

OW-yehisa pinned the model in `resources/probes/agentpane_pi_smoke.py`, `agentpane_codex_smoke.py` and `capture_fixtures.py`, for the reason `AGENTS.md` gives under "Evidence" ("the flag is the whole of the constraint and is never optional"); its review found two more probes with the same defect, outside that card's scope.

- `resources/probes/fork_probe.py`: `PiSession` spawns `["pi", "--mode", "rpc", "--session-dir", ...]` with no `--model`, and its Codex driver spawns a bare `["codex", "app-server"]` whose `thread/start` calls (the cell sending `thread/start` with `{}`, and the one with `{"cwd": str(mid_work), ...}`) and whose `turn` and `start_turn` methods all send no `model`.
  It already reads back `started["result"].get("model")` into a `"model"` field, so the read-back exists and only the flag is missing.
- `resources/probes/pi_rpc_probe.sh`: `pi --mode rpc --no-session` with no `--model`.

Prior art for each shape: `agentpane_pi_steer_probe.py` and `session_name_probe.py` for Pi (`--model openrouter/deepseek/deepseek-v4.1-flash:high`), and `codex_fork_same_process_probe.py` for a bare `codex app-server` — its comment "app-server takes no flag, so the pin rides on every turn/start" and its `MODEL` constant on `turn/start`; `session_name_probe.py` sends it on `thread/start` instead.
`codex_fork_history_probe.py` sends no `model` on `thread/start` but drives its turns through `codex_fork_same_process_probe.run_turn`, which pins, so it is not in scope.

The load-bearing part is that each spawn or thread passes the pinned model explicitly and the probe records the flag beside whatever it reads back; a `--model` override flag is incidental.

## Done when

`fork_probe.py` passes `--model` to every Pi it spawns and `model` on every Codex `thread/start` or `turn/start` it sends, and `pi_rpc_probe.sh` passes `--model`, each defaulting to the ref `AGENTS.md` pins; `python3 -m py_compile resources/probes/fork_probe.py` and `bash -n resources/probes/pi_rpc_probe.sh` pass.
`resources/probes/README.md`'s sections for both say they pass the pin.
No live run is required by this card; the next run of either records the flag in its output, and its "Verified with" line stays as it is until then.
