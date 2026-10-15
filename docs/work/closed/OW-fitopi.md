---
labels: [unverified]
closed: done
---

# agentpane_pi_smoke.py has never been shown to pass in a session whose sandbox mounts ~/.pi/agent read-only, which is what a card run session gets

Filed 2026-10-14 at OW-robozi's close.

OW-robozi found that a `card run` session, started as plain `sbox claude`, has `~/.pi/agent` read-only, and `AGENTS.md`, "Do not assume how your session was launched", now says such a session gives a live Pi run a throwaway state directory instead.
`resources/probes/agentpane_pi_smoke.py` already does that: it builds one with `make_state_home` in `resources/probes/agentpane_live_support.py` and passes `PI_CODING_AGENT_DIR` into the server it starts, whose spawn chain is `direnv exec <workspace> sbox -- pi --mode rpc`.
`docs/HANDOFF.md`, "Each backend needs a writable state directory", records that an inner `sbox` cannot make writable what the outer sandbox mounted read-only, so the variable is the only thing standing between that chain and the failure.
Every recorded pass of the probe (`resources/probes/README.md`, its "Verified with" lines) was in a session nothing records the launch of, and since 2026-09-13 an interactive session on the home server has had `~/.pi` writable, so none of them shows the read-only case.

In service of the guidance in `AGENTS.md` being true for the session it was written for, rather than inferred from code.
Load-bearing: the run happens in a session where `~/.pi/agent` really is read-only, so it is executed through `card run`, and it first shows that with `touch ~/.pi/agent/.probe` failing; if that touch succeeds, this session is not the case, and the card hands back open rather than running the probe.

## Done when

`docs/MANUAL_TESTING.md` records, with the date, `pi --version` and how the session was launched, the failed touch and a run of `python3 resources/probes/agentpane_pi_smoke.py --tool-check` with the pinned model, and whether it passed.
If it failed for the state directory, the failure is named and a `defect` card is filed for it; whatever the outcome, `AGENTS.md`'s "Do not assume how your session was launched" and `resources/probes/README.md`'s entry for the probe name the run.

## Close note

Done 2026-10-14 on the home server, `pi 1.2.0`, in a session launched by `card run OW-fitopi` (process tree: `claude … --name card run OW-fitopi` under a `bwrap` binding nothing under `~/.pi`).
`touch ~/.pi/agent/.probe` failed with `Read-only file system`, so the session was the case.
`python3 agentpane_pi_smoke.py --tool-check --model openrouter/deepseek/deepseek-v4.1-flash:high`, from `resources/probes/`, passed every check (startup, text_stream, idle, rename, model, tool_output, abort, shutdown, cleanup) in 40s; the session id Pi adopted was a JSONL path under the throwaway `/var/tmp/agentpane-live-pihome-*` home, showing `PI_CODING_AGENT_DIR` reached Pi through the inner `sbox`.
No defect card: it did not fail.
The adversarial read found that the card's premise was slightly overstated: the OW-niwusi runs (2026-09-30, `pi 0.87.1`) already passed with `~/.pi/agent/sessions` read-only, though without a recorded launch or a test of `~/.pi/agent` itself; the write-up says so.
Not tried: the chain without the variable, so the run shows the variable suffices, not that it is still necessary.
Recorded in `docs/MANUAL_TESTING.md`, "The Pi smoke probe passes in a `card run` session whose `~/.pi/agent` is read-only (OW-fitopi)", with one line each in `AGENTS.md`, "Do not assume how your session was launched", and in `resources/probes/README.md`'s `agentpane_pi_smoke.py` entry.
