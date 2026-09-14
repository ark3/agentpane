---
labels: [unverified]
closed: done
---

# Re-measure the Pi state-directory gotcha after the sandbox grants write access to ~/.pi/agent

`docs/HANDOFF.md` "Environment gotchas", `AGENTS.md` "Evidence" (the Pi pin), `docs/MANUAL_TESTING.md` ("Pi arrives on the home server")

As of 2026-09-13 the sandbox mounts `~/.pi/agent` read-only, so Pi cannot take the lock it needs merely to read `settings.json` and resolves no model at all — `get_state` answers `"id": "unknown"`, `thinkingLevel: "off"`.
The owner intends to grant write access at the next sandbox restart, which was deferred that day because another session was mid-work.

Three places state or lean on the read-only condition and all three want re-measuring together, not editing from memory:

- `docs/HANDOFF.md`'s "Pi and Codex each need a writable state directory" bullet, whose Pi half may become historical while its Codex half stands.
- The same section's claim that sbox "has `pi` and `codex` profiles already (mounts `~/.pi/agent` / `~/.codex` rw)", which reads as though it already worked and sits three lines from the EROFS evidence contradicting it.
- The Pi sentence in `AGENTS.md`'s model pin, which cites the read-only mount as the reason the flag is mandatory.

The flag stays mandatory either way — machine defaults are not trusted here for any of the three CLIs — but its stated reason changes if the mount does.

## Done when

After the restart, with the mount's actual state measured rather than assumed: a bare `pi --mode rpc` against the real `~/.pi/agent` has been asked for `get_state`, and whichever model it reports is recorded in `docs/MANUAL_TESTING.md` against the date and `pi` version.
The three passages above agree with that reading, each keeping its measurement date.

## Close note

The sandbox restart landed the same evening this card was filed, 2026-09-13, and the re-measurement it asked for ran against the real directories rather than from memory.

Measured (`pi 0.85.1`, `codex-cli 0.154.0`, home server): `~/.pi/agent`, `~/.codex` and `~/.claude` are all writable now, while `$HOME` itself still is not — so the sandbox is on and HANDOFF's test for that survives.
Pi resolves `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"` from the real state directory, both directly and through `sbox --` run from the repo root, and drives a turn to `stopReason: "stop"`; the `EROFS` warning on stderr is gone.
`codex app-server` starts with no sqlite error.

All three passages this card named were reconciled in 8468a02.
The HANDOFF gotcha now carries its pre-restart evidence as dated history rather than dropping it — that evidence is why `capture_fixtures.py` and `fork_probe.py` carry throwaway state dirs, and those keep their other purpose of staying off the real corpus and credentials.
Its sbox-profiles neighbour is no longer in conflict, and the note saying so is in the bullet rather than beside the sentence.
The model pin in AGENTS.md stays a flag on all three CLIs: the pre-restart `"id": "unknown"` reading is precisely the failure the flag survives, and a readable settings file is still a mutable one.

Evidence in `docs/MANUAL_TESTING.md`, "The sandbox restart makes the backend state directories writable".
OW-moradi is unaffected and still open: nothing has yet driven Pi through the built server on this machine.
