---
labels: [unverified]
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
