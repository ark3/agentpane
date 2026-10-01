---
labels: [defect]
closed: done
---

# fork_probe.py and pi_rpc_probe.sh still take their model from the mutable settings files, not from the pin

OW-yehisa pinned the model in `resources/probes/agentpane_pi_smoke.py`, `agentpane_codex_smoke.py` and `capture_fixtures.py`, for the reason `AGENTS.md` gives under "Evidence" ("the flag is the whole of the constraint and is never optional"); its review found two more probes with the same defect, outside that card's scope.

- `resources/probes/fork_probe.py`: `PiSession` spawns `["pi", "--mode", "rpc", "--session-dir", ...]` with no `--model`, and its Codex driver spawns a bare `["codex", "app-server"]` whose `thread/start` calls (the cell sending `thread/start` with `{}`, and the one with `{"cwd": str(mid_work), ...}`) and whose `turn` and `start_turn` methods all send no `model`.
  It already reads back `started["result"].get("model")` into a `"model"` field, so the read-back exists and only the flag is missing.
- `resources/probes/pi_rpc_probe.sh`: `pi --mode rpc --no-session` with no `--model`.

Prior art for each shape: `agentpane_pi_steer_probe.py` and `session_name_probe.py` for Pi (`--model openrouter/deepseek/deepseek-v4.1-flash:high`), and `codex_fork_same_process_probe.py` for a bare `codex app-server` — its comment "app-server takes no flag, so the pin rides on every turn/start" and its `MODEL` constant on `turn/start`; `session_name_probe.py` sends it on `thread/start` instead.
`codex_fork_history_probe.py` sends no `model` on `thread/start` but drives its turns through `codex_fork_same_process_probe.run_turn`, which pins, so it is not in scope.

Two neighbours read this fact and must stay right.
`resources/probes/claude_fork_probe.py` justifies its unflagged `MODEL` constant with "`fork_probe.py` exposes no model flag either"; that clause becomes false and is retired in the same change, per `AGENTS.md` "retire every copy".
`resources/probes/hydrate_window_probe.py` subclasses `PiSession` as `PinnedPiSession`, overriding `__init__` to add `--model`; the change must leave it working, and collapsing it into the base class is not this card's work.

The load-bearing part is that each spawn or thread passes the pinned model explicitly and the probe records the flag beside whatever it reads back; a `--model` override flag is incidental.

## Done when

`fork_probe.py` passes `--model` to every Pi it spawns and `model` on every Codex `thread/start` or `turn/start` it sends, and `pi_rpc_probe.sh` passes `--model`, each defaulting to the ref `AGENTS.md` pins; `python3 -m py_compile resources/probes/fork_probe.py` and `bash -n resources/probes/pi_rpc_probe.sh` pass.
`resources/probes/README.md`'s sections for both say they pass the pin.
No live run is required by this card; the next run of either records the flag in its output, and its "Verified with" line stays as it is until then.

## Close note

Pinned the model in the two probes that still took it from Pi's and Codex's settings files.
`resources/probes/fork_probe.py` gained `PI_MODEL` and `CODEX_MODEL` constants holding the refs AGENTS.md "Evidence" pins: `PiSession.__init__` passes `--model PI_MODEL`, and both Codex `thread/start` calls and `CodexSession.turn` / `start_turn`'s `turn/start` carry `model`.
Each cell that drives a turn records `model_flag` beside a read-back: Pi's `model_in_force` (provider/id from the first `get_state`, as `hydrate_window_probe.py` does) and Codex's `model` from the `thread/start` response.
`resources/probes/pi_rpc_probe.sh` passes `--model "$PI_MODEL"` and prints the flag above the `message_end` payload, which carries `model`.
`resources/probes/README.md`'s two sections say so and that the pin postdates their unchanged "Verified with" lines; `claude_fork_probe.py`'s comment that "`fork_probe.py` exposes no model flag" was retired.
Verified by `py_compile` on fork_probe.py, hydrate_window_probe.py and claude_fork_probe.py and `bash -n` on pi_rpc_probe.sh; no live run, per the card.
An adversarial read confirmed every Codex turn and Pi spawn carries the pin (`thread/fork` sends no `model`, but per the codex adapter's OW-sayaju note a turn naming the model runs on it) and caught a new "app-server takes no model flag" clause that `capture_fixtures.py`'s `codex -m ... app-server` contradicts; it was dropped.
Left as is, from that read: both read-backs are taken before the forks and clones the cells are about, and Pi's drops `thinkingLevel`; `hydrate_window_probe.PinnedPiSession` now duplicates the base class except for `--session`.
