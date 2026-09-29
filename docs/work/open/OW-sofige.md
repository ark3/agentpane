---
labels: [defect, sweep-0929]
---

# assistant_length_at_abort is a session maximum, so it cannot attribute itself to the aborted turn

Both smoke probes report the pre-abort transcript size as `assistant_length_at_abort` — `resources/probes/agentpane_pi_smoke.py` in section `-- 4. abort, then shutdown without an orphan --`, and `resources/probes/agentpane_codex_smoke.py`, which computes the same thing into a local named `length_at_abort`.
Both read it with `max_assistant_length` (`resources/probes/agentpane_live_support.py`), which is "the longest assistant message in the session", not the length of the turn being aborted.

The number therefore cannot say which message it came from.
Under `--tool-check` two turns precede the aborted one, so a longer earlier reply would silently stand in for it.
The post-abort growth check immediately below has the same blind spot from the other direction: it compares that session maximum before and after the abort, so a *shorter* message arriving after the abort would not move it and the check would pass.

Measured, not assumed: as of `pi 0.85.1` on 2026-09-13 the blob offers no bound that settles ownership either.
`checks.text_stream` reports the first turn at 77 and 44 characters, but `growing_assistant_text` returns as soon as growth is established, so that is a mid-stream sample rather than the finished reply — and under `--tool-check` the first turn then ran a further 8.5 seconds past it.
`docs/MANUAL_TESTING.md`, "The Pi smoke probe's abort is now provably aimed at the long turn" (OW-hahohi), records this under "Read `assistant_length_at_abort` as an upper bound, not as the aborted turn's length", and OW-hahohi left it as a documented limit rather than fixing it.

This matters most for OW-fagemo, which wants the abort phase to tear down a genuinely large transcript: a bigger `assistant_length_at_abort` there proves nothing about the aborted turn unless the number is attributed to it.

## What this needs

A length read against the aborted turn's own message rather than the session.
The SSE events carry message identity — see how `growing_assistant_text` and `max_assistant_length` walk `upsert` and `snapshot` payloads in `resources/probes/agentpane_live_support.py` — so a helper keyed on the message id that the aborted turn's `upsert` events name would do it, and it belongs in the shared support module because both probes need it.
The growth check should then compare that message's length rather than the session maximum, which is what makes "the transcript stopped growing" a claim about the turn that was aborted.

## Done when

Both probes report the aborted turn's own transcript length, and the post-abort growth check compares that length.
Seen red first: a deliberate break — comparing the wrong message, or asserting the growth check against a message that did grow — must fail the run, and the failure is recorded.
A run of each probe on the home server then passes, written up in `docs/MANUAL_TESTING.md` with the version it was measured on, and the "upper bound, not the aborted turn's length" paragraph in the OW-hahohi section is retired in the same change rather than left standing beside its correction.

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) folded OW-fagemo into this card, which closed `--moot`: its done condition, a pre-abort transcript tens of kilobytes long, means nothing without this card's per-turn attribution, and both probes' abort phases send the same prompt (`agentpane_pi_smoke.py` and `agentpane_codex_smoke.py`) and read the length through the same `max_assistant_length` in `resources/probes/agentpane_live_support.py`.
So this is one change to the support module and one live run per backend.

Done also requires OW-fagemo's condition, measured by this card's per-turn length: a run of each probe on the home server whose aborted turn is of a different order than a few hundred characters, with the abort answered and the transcript not growing afterwards.
OW-fagemo's escape stands too: if a backend's pinned model refuses every reasonable long prompt, record that beside the prompt and in `docs/MANUAL_TESTING.md` and close on that evidence.
Run it after OW-yehisa lands, so the Pi run is pinned.
