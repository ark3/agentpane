---
labels: [unverified]
closed: done
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

## Close note

Re-measured, and the fact had not moved.

**2026-09-12, home server, `codex-cli 0.154.0`.** Two new no-turn cells in `resources/probes/approval_policy_probe.py`, its `(d)` question, re-runnable alone with `python3 resources/probes/approval_policy_probe.py --only d`.
Each starts one thread with `{"ephemeral": true, "cwd": <fresh git workspace>}` and no `sandbox` and no `approvalPolicy` key, and reads the `thread/start` response; the answer is on that response, so neither drives a model turn and the pair costs no tokens.
They differ only in how `app-server` was spawned.

Under `codex app-server` the response reported `sandbox: {"type":"readOnly","networkAccess":false}` and `approvalPolicy: "on-request"`.
Under `codex --sandbox danger-full-access app-server` -- the exact invocation sbox produces -- it reported the same two values, byte for byte.
The copied `~/.codex/config.toml` set no sandbox key and no `approval_policy` (its key names were `model`, `model_reasoning_effort`, a `[projects."..."]` trust entry, a `[notice.model_migrations]` block and two `[plugins."..."]` toggles), which is what licenses reading those as app-server's own defaults rather than the operator's configuration.
The dispatching session re-ran the pair independently of the implementer and got identical values.

So OW-37's 0.147.0 answer survives two version bumps: the injected CLI flag is still ignored, and a bare `thread/start` still defaults to `read-only`.
The card's open question -- one stale fact, or two genuinely different per-path defaults -- comes out **two different defaults**.
A bare `thread/start` is `readOnly`; a bare `thread/fork` off a `dangerFullAccess` parent is `workspaceWrite` (OW-18, same CLI version).
A fork is not falling back to the start default but to a third value, wider than the start default and narrower than the parent it forked from.
Nothing was measured about `thread/resume`.

No code changes: the adapter already passes `sandbox` explicitly on all three thread-creation paths (D7a), which is correct against either default and against both at once.
What the run buys is that the stated *reason* for doing so is now true on the installed CLI, and that passing it on each path is documented as not being symmetry -- there is no single default to lean on.

Copies retired, all in the one commit.
The card named three; a fourth live one turned up in `docs/HANDOFF.md` and was fixed too.

- `docs/DESIGN.md`, the "Spawning through sbox" Codex bullet -- the two defaults are now one versioned statement with the fork's `workspaceWrite` beside it, rather than three lines apart and unacknowledged.
- `src/server/adapters/codex/process.ts`, the `codexCommand` docblock.
- `docs/HANDOFF.md`, the sbox bullet.
- `docs/DESIGN.md` D18 gains a sentence saying its named example was closed by re-measurement, so it is not read as a still-open defect.
- This card's own third copy, in closed `OW-laliku`: a note appended to that card's close note, since its body is a quotation of the wording as it stood then.

Landed on `main` in 2e279c7. `bun run check` green (49 files, 1027 tests), run by the dispatching session as well as the implementer.
Evidence in `docs/MANUAL_TESTING.md`, "Observed Codex app-server sandbox default on a bare `thread/start` (OW-pibivi)".

Left alone deliberately: `docs/DESIGN.md` (the OW-37 citations in the D7a discussion) and `resources/fixtures/README.md` each assert only the *no-op* half with no version.
This run re-confirms them, but they license no code and are D18's third group, free to age.
`AGENTS.md`'s house-style example still describes the sentence as sitting "three lines from a 0.154.0 measurement", which this change ends; it reads as past-tense history of the incident and was left standing.
