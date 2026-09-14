---
labels: [unverified]
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
