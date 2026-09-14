---
labels: [unverified]
---

# Pi's mid-turn 202 is unmeasured: show that the steer lands in the running turn

Observed on the home server 2026-09-13, `pi 0.85.1`, in the `--tool-check` run recorded in `docs/MANUAL_TESTING.md` ("The Pi smoke probe runs on the home server, end to end through the built server").
The probe posted a second prompt 42 ms after a `toolCall` block arrived, while the first turn was still streaming, and the server answered **202**.
That was incidental to what the probe was checking — it surfaced as a side effect of the defect in OW-hahohi — but it is not a probe defect, and it will vanish from the record the moment OW-hahohi's overlap is repaired, which is why it is filed here.

**Amended 2026-09-14 during execution.**
This card was filed as a `question` asking what agentpane's cross-backend contract is for a prompt submitted mid-turn.
That decision already existed when the card was written: **D16** in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects"), taken by the owner on 2026-09-09 under OW-rifezo.
D16 answers the whole of the question, including why the three adapters may differ: steer where the backend can, reject where it cannot, and never silently downgrade to a follow-up.
So the card is now the prerequisite it named as load-bearing, and its kind is `unverified` rather than `question`.

What is genuinely unmeasured is Pi's half of D16.
Claude Code's rejection was settled live (`docs/MANUAL_TESTING.md`, "Observed Claude Code mid-turn prompt handling", OW-jihete, `claude 2.1.267`) and Codex's steer was settled live ("Observed Codex `turn/steer` against a live turn", OW-tifuha, `codex-cli 0.154.0`).
Pi has no such section.
D16's sentence "Pi is already correct" rests on `resources/pi-protocol` docs plus the adapter's own code — `submit()` in `src/server/adapters/pi/process.ts` sets `streamingBehavior: "steer"` when `this.state.isStreaming` — and on nothing that was ever run.
A 202 that steers the prompt into the running turn, a 202 that queues it for a following turn, and a 202 that silently drops it are three different products behind one status code, and only the first is D16.

## Done when

A section in `docs/MANUAL_TESTING.md`, citing the `pi` version it ran against, records a live run through the built server in which a second prompt is posted while a Pi turn is streaming, and says which of the three the 202 was: the text answered inside the running turn, answered in a following turn, or never answered at all.
The evidence has to distinguish them rather than leave a reader inferring it — count the turn boundaries Pi reports, do not read arrival timestamps as durations (the hazard OW-hahohi recorded).
`resources/probes/agentpane_pi_smoke.py` is the vehicle to copy from rather than to extend, and OW-hahohi's repair to it is the worked example of aiming a phase at the turn it means.

Then, whichever way it comes out, D16 gains the measured citation for Pi alongside the two it already carries for Claude and Codex, in the form D18 requires — the `pi` version named, present tense refused.

If the run shows the prompt is queued for a following turn or dropped, that is a divergence from D16 and gets its own `defect` card; do not fold it into D16 as though D16 had said so.
