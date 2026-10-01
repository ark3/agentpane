---
labels: [defect, sweep-0929]
closed: done
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
The SSE events carry message identity — see how `growing_assistant_text` and `max_assistant_length` walk `upsert` and `snapshot` payloads in `resources/probes/agentpane_live_support.py` — so a helper keyed on the message the aborted turn's `upsert` events name would do it, and it belongs in the shared support module because both probes need it.
The wire names a message by position, not by id: an `upsert` carries `index`, the position in the very array `snapshot.messages` addresses (`src/shared/protocol.ts`, the `upsert` member of the SSE event union, and `ForkPoint.index` beside it); `PaneMessage` carries no id of its own (amended 2026-09-30 on checking the card against the source).
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

## Close note

Both smoke probes now report `assistant_length_at_abort` from the aborted turn's own messages. The growth check after the abort compares those messages, not the session maximum. Landed on main as 89ee407, 092e3cb, d657fb9 and 3bd09ad.

What was built, in `resources/probes/agentpane_live_support.py`:
- `transcript` replays the session the way a client holds it: a `snapshot` replaces it, an `upsert` writes at `index`. The wire names a message only by position.
- `turn_messages` returns every position past the transcript's length at a cut taken just before the long prompt. That cut is idle: the Pi probe asserts it, and the Codex probe infers it.
- The reported length is the sum of the turn's assistant text, so a turn split across several messages counts in full. The floor excludes earlier turns.
- The growth check compares the rows position by position, at idle and again 1.5 s later.
- `max_assistant_length` stays for the steer probe and for the Codex reconnect check.

OW-fagemo, folded in:
- Both pinned models failed the integers prompt. Luna's turn (`codex-cli 0.157.1`) ended on its own at 76 characters. Pi's runs on 0.85.1 and 0.87.1 stayed at session maxima of 472 or less.
- Both probes now share `LONG_PROMPT`, a twenty-chapter handbook.
- `wait_for_turn_to_fill` replaces the 0.35 s sleep. It waits up to 150 s for 20000 characters of the turn's own text, and it asserts no length.

Runs on the home server, 2026-09-30, `pi 0.87.1` and `codex-cli 0.157.1`, pinned models, all passing:
- Codex: 20005 characters at abort, idle 15 ms after the abort request.
- Pi bare: 20054 characters, idle after 10 ms.
- Pi `--tool-check`: 20021 characters, idle after 36 ms. The turn sat at positions 7 and 8, past the seven messages from earlier turns.
- In all three, the turn did not change in the 1.5 s after idle.

How red was shown:
- Live: comparing against the turn as it stood half-filled failed the Pi run with exit 1.
- Synthetic event list: the old helper reported an earlier 5000-character reply for a 400-character aborted turn, and missed both a late message and a late growth. The new one caught both.

Write-up: `docs/MANUAL_TESTING.md`, "The smoke probes abort the long turn's own text, twenty thousand characters in (OW-sofige)". The OW-hahohi "upper bound" paragraph is retired. Pointers were added where the OW-moradi and OW-yehisa sections cite session maxima.

Known limits, recorded in that section:
- The growth check compares text length only, so a change to thinking or `stopReason` after idle passes.
- The idle baseline is read at the next 50 ms poll, not at the idle event. OW-wawese carries that fix.
