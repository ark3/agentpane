---
labels: [unverified]
---

# The repo asserts app-server defaults a thread to read-only in three places, measured on 0.147.0 and never rechecked, three lines from a 0.154.0 fork measurement of workspaceWrite

The claim is in `docs/DESIGN.md` under the Codex spawn bullet ("ignores the CLI flag and defaults each thread to `read-only`"), in the `codexCommand` docblock in `src/server/adapters/codex/process.ts`, and quoted a third time in the closed `OW-laliku`.

`OW-37` measured it, and named its version: verified against `codex-cli 0.147.0`, a thread started as `codex --sandbox danger-full-access app-server` still reported `sandbox: {type:"readOnly"}`.
None of the three copies carries that version, so all three read as present fact.

## Why it is worth settling rather than just stamping

The OW-18 run was on `0.154.0` and measured a *bare fork* returning `workspaceWrite`. That sits three lines below the `read-only` claim in `docs/DESIGN.md`, with nothing acknowledging that they differ.
Two genuinely different per-path defaults is plausible. So is one stale fact. A reader today cannot tell which, and the same session recorded that the wire changed materially between those two versions.

Every `thread/start` cell in the OW-18 probe passed `sandbox` explicitly, so the bare-start default was not re-measured on `0.154.0`.

Nothing breaks either way -- the adapter passes `sandbox` on all three paths (D7a), which is D18's first group, where the code already defends itself.
What is at stake is that the stated reason for doing so is either right or two versions out of date, and it is cheap to know which.

## Done when

A cell in `resources/probes/approval_policy_probe.py` starts a thread with no `sandbox` key and records what the response reports, on the installed CLI, into `docs/MANUAL_TESTING.md`.

Then all three copies are brought into line in the same change -- a run that overturns a recorded fact retires every copy of it, and this one has three.
If the default still is `read-only`, they gain the version and the date. If it has moved, they say what it is now and the `workspaceWrite` fork finding is restated beside it as the same fact rather than a neighbouring puzzle.

This needs a live Codex run on the home server, and pairs naturally with `OW-wujuda` or `OW-zogogo`, both of which need one too.
