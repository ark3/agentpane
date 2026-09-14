---
labels: [question]
---

# Pi accepts a mid-turn prompt with 202 where Claude Code rejects one: decide which is the contract

Observed on the home server 2026-09-13, `pi 0.85.1`, in the `--tool-check` run recorded in `docs/MANUAL_TESTING.md` ("The Pi smoke probe runs on the home server, end to end through the built server").
The probe posted a second prompt 42 ms after a `toolCall` block arrived, while the first turn was still streaming, and the server answered **202**.
That was incidental to what the probe was checking — it surfaced as a side effect of the defect in OW-hahohi — but it is not a probe defect, and it will vanish from the record the moment OW-hahohi's overlap is repaired, which is why it is filed here.

The decision nobody has made: **what agentpane's contract is for a prompt submitted while a turn is active, across backends.**

The two backends disagree today.
Claude Code's adapter rejects `submit()` outright while a turn is active — settled live on the home server 2026-09-10, `claude 2.1.267`, and recorded in `docs/MANUAL_TESTING.md` (OW-jihete): a stream-json user message written during a turn is acknowledged only after the first `result` and runs as a second turn, while a `steer` control request errors as unsupported, so the adapter refuses rather than let the message sit.
Codex is the third data point and is not the same as either: `turn/steer` genuinely works against a live turn there (`docs/MANUAL_TESTING.md`, OW-tifuha, `codex-cli 0.154.0`), so Codex can honour a mid-turn message inside the running turn.
Pi apparently accepts the prompt and returns 202 — but what it then *does* with it is unmeasured, and that is the load-bearing gap: a 202 that queues the prompt for after the turn, a 202 that interleaves it, and a 202 that silently drops it are three different products behind one status code.

So this is a question card and not a defect card: it is not established that either side is wrong.

## Done when

A decision is recorded in `docs/DESIGN.md` as a numbered decision, saying what a mid-turn submit does for each of the three backends and why they may differ — the honest answer may well be that they differ because the CLIs differ, in which case say that, since three adapters behaving three ways by accident and by design look identical from the outside.
Measuring what Pi's 202 actually does is a prerequisite and belongs to whoever picks this up: drive a Pi session through the server, post a second prompt mid-turn, and record whether the text lands in that turn, in a following turn, or nowhere — a run on the home server can do this now, and `resources/probes/agentpane_pi_smoke.py` is the vehicle to copy from rather than to extend.
If the measurement shows the prompt is dropped, that is a defect and gets its own card; do not fold it into the decision.
