---
labels: [question]
---

# A session on the home server found ~/.pi/agent read-only on 2026-10-14, so a live Pi turn could not run as AGENTS.md describes

Filed 2026-10-14 by OW-zarine's execution.

AGENTS.md, under "Evidence", in the paragraph opening "**All three CLIs run on the home server, each pinned to one model.**", records that the sandbox was widened on 2026-09-13 to mount `~/.pi/agent/` read-write, and that a read-only mount makes Pi resolve no model at all.
`docs/HANDOFF.md`, "Environment gotchas", records the same widening and its measurement after the change (OW-vowire, `pi 0.85.1`), and the `sbox` entry there says its `pi` profile mounts `~/.pi/agent` read-write.
On 2026-10-14 both the dispatching session and its implementer found that directory read-only again: `touch ~/.pi/agent/.probe` failed with `Read-only file system`, and `pi 1.2.0 --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash:high` refused the `prompt` with `Credential store read failed for openrouter: EROFS: read-only file system, mkdir '/home/ark3/.pi/agent/auth.json.lock'`.
The implementer got its run by pointing `PI_CODING_AGENT_DIR` at a scratch directory holding copies of `auth.json`, `models-store.json` and `settings.json`, then deleting it; `docs/MANUAL_TESTING.md`, "Pi stamps each reply with its level, and `get_messages` carries it (OW-zarine)", records that.
That workaround copies a credential file into `/tmp`, so it is not one to write into AGENTS.md as the procedure without the owner choosing it.

In service of every card that needs live Pi evidence on the home server: the next session should not discover the mount by failing.

What is undecided: whether the read-only mount is a regression in the sandbox (`sbox`) to put back, or the intended state now, and if intended, what a session is to do for a live Pi turn.
The mount itself is the owner's provisioning of the machine, not a session's work.

## Done when

The decision is recorded in AGENTS.md beside the 2026-09-13 sentence, dated: either the mount is read-write again, shown by a session's `touch ~/.pi/agent/.probe` succeeding (and removing the probe), or the sanctioned way to run a live Pi turn without it is written there.
