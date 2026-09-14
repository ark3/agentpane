---
labels: [unverified]
closed: done
---

# Run the Pi smoke probe on the home server: nothing has driven Pi through the built server there

`resources/probes/agentpane_pi_smoke.py`, `docs/MANUAL_TESTING.md` ("Pi arrives on the home server")

The home server got `pi 0.85.1` on 2026-09-13, and the run recorded in MANUAL_TESTING that day went no further than `pi --mode rpc` driven by an ad-hoc script.
It never touched the server, the adapter, or a fork.
So the Pi adapter has never been exercised end to end on this machine, and the probe written for exactly that has never run here.

This is the cheapest thing the install makes newly possible, which is the whole reason to file it.
The sandbox restart later that same day made `~/.pi/agent` writable, so the throwaway `PI_CODING_AGENT_DIR` is no longer forced by the environment; the probe sets one unconditionally anyway, and that is left alone here.

## Done when

`python3 resources/probes/agentpane_pi_smoke.py` has run on the home server and its result is recorded in `docs/MANUAL_TESTING.md` with the `pi` version.
A failure is a result: record it and file what it exposes rather than fixing it here.

## Close note

Run on the home server 2026-09-13 at commit `967b319`, `pi 0.85.1`, twice: `python3 resources/probes/agentpane_pi_smoke.py` bare, then again with `--tool-check`.
Both exited 0 with `"result": "pass"` and every check inside them passing, in 16 and 19 seconds respectively.
The evidence is written up in `docs/MANUAL_TESTING.md`, "The Pi smoke probe runs on the home server, end to end through the built server", committed as 6cdea48.

What it establishes here: the production `direnv exec <cwd> sbox -- pi --mode rpc` chain starts exactly one agent through `bun → bwrap → bwrap → pi`, `direnv` and `sbox` leaving no process; the rename lands during attach and the superseded `virtual:` id keeps resolving; an abort is answered in 16 ms with no further transcript growth; SIGTERM leaves no run-scoped worker.
HANDOFF findings 39-42 came from the work laptop on `pi 0.84.1`, and 39, 40 and 41 reproduce unchanged on 0.85.1 — this run is the first on this machine, not the first anywhere.

The run also retired every copy of the claim it overturned — the "What this leaves open" paragraph of the preceding MANUAL_TESTING section, `resources/probes/README.md`, and the probe's own module docstring — and qualified `docs/HANDOFF.md` finding 42 twice: this machine has no `trust.json` for the harness to copy, and finding 42's cited evidence is a field the probe captures before the tool prompt is ever sent.

Three defects fell out, all in what the harness measures rather than in what it exercises, and each was filed rather than fixed here as the card asked: OW-guvojo (the evidence never records the model), OW-hahohi (the abort phase's long prompt is not long, and under `--tool-check` it may abort the tool turn), OW-lapuye (`agent_requests_seen` is snapshotted before the tool prompt, which is also what finding 42 rests on).
