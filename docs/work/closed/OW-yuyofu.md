---
labels: [unverified]
closed: done
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
D16's sentence "Pi is already correct" rests on Pi's own `rpc.md` reference plus the adapter's own code — `submit()` in `src/server/adapters/pi/process.ts` sets `streamingBehavior: "steer"` when `this.state.isStreaming` — and on nothing that was ever run.
A 202 that steers the prompt into the running turn, a 202 that queues it for a following turn, and a 202 that silently drops it are three different products behind one status code, and only the first is D16.

## Done when

A section in `docs/MANUAL_TESTING.md`, citing the `pi` version it ran against, records a live run through the built server in which a second prompt is posted while a Pi turn is streaming, and says which of the three the 202 was: the text answered inside the running turn, answered in a following turn, or never answered at all.
The evidence has to distinguish them rather than leave a reader inferring it — count the turn boundaries Pi reports, do not read arrival timestamps as durations (the hazard OW-hahohi recorded).
`resources/probes/agentpane_pi_smoke.py` is the vehicle to copy from rather than to extend, and OW-hahohi's repair to it is the worked example of aiming a phase at the turn it means.

Then, whichever way it comes out, D16 gains the measured citation for Pi alongside the two it already carries for Claude and Codex, in the form D18 requires — the `pi` version named, present tense refused.

If the run shows the prompt is queued for a following turn or dropped, that is a divergence from D16 and gets its own `defect` card; do not fold it into D16 as though D16 had said so.

## Close note

Closed as the measurement it was amended into, not as the question it was filed as.

**The drift, found in step 1.** The card asked for a numbered decision in `docs/DESIGN.md` saying what a mid-turn submit does per backend. That decision already existed when the card was written: **D16**, taken by the owner on 2026-09-09 under OW-rifezo, four days earlier. It answers the whole question, including why the three adapters may differ. What survived was the card's own stated prerequisite — Pi's half of D16 had never been run — so the card was relabelled `question` -> `unverified` and rewritten to ask for that measurement (`891d487`).

**The answer: as of `pi 0.85.1`, a prompt posted mid-turn is steered into the running turn.** D16's first outcome, not a following turn and not a drop. Six runs on the home server, 2026-09-14, through the built server on the production `direnv exec <workspace> sbox -- pi --mode rpc` chain, answered by `openrouter/deepseek/deepseek-v4.1-flash`.

The evidence that discriminates is **one fact**: Pi's own `queue_update`, arriving as the very next line after the POST, carried the marker in `steering` with `followUp` empty. None of this reaches agentpane's SSE wire — `src/server/adapters/pi/reducer.ts` drops `turn_start`, `turn_end`, `agent_end` and `queue_update` — so the probe taps Pi's stdout through a `pi` shim first on the server's PATH.

The second fact, that `agent_settled` never fell between the request and its answer, is necessary and **not** sufficient, and the first write-up of this got that wrong: it rules out a follow-up delivered after the turn, but a `followUp` queue drained inside the same span would read identically, because the reducer records that an `agent_end` can be followed by queued continuations. Both documents now say which is evidence and which is corroboration.

Two finer signals decide nothing. Pi's `turn_start`/`turn_end` bound one LLM round and carry no id at all, so OW-tifuha's "same turn id" test is impossible on Pi rather than merely inapplicable; `agent_end` came out both ways across runs, a race against how much the model had left to say. The boundary was widened to `agent_settled` after a run failed under `agent_end` — the shape of a boundary fitted to its answer — so the write-up now justifies it from `resources/fixtures/pi/tool-read.jsonl`, which held two `turn_*` pairs inside one `agent_start`...`agent_settled` span long before any of this and with no steer involved.

**Landed.** `resources/probes/agentpane_pi_steer_probe.py` with a `resources/probes/README.md` entry (`0b39003`); the evidence section "A prompt posted mid-turn is steered into Pi's running turn" at the end of `docs/MANUAL_TESTING.md` (`26b6c3a`, `f2af5a7`, `bf91e51`); D16's Pi citation in `docs/DESIGN.md` (`f2af5a7`, `bf91e51`); probe corrections in `9a50201` and `ead1931`.

**What the adversarial read caught**, all of it confirmed against the source before acting on it: the probe passed on a `dropped` verdict, which is the exact outcome this card called a divergence from D16, so the check could never go red on the answer that mattered — only `steered_into_running_turn` passes now, and the classifier was exercised offline against six synthetic timelines to watch each other shape go red. A run with no `queue_update` naming the marker fell back to the non-discriminating boundary and still passed; the two readings must now agree. The reported 30.343 s was built after the probe's own 2 s settle pad. `resources/pi-protocol` does not exist. The shim does not pass Pi's exit status through, since `sh` reports a pipeline's last stage.

**Limits, stated in both documents rather than left for a reader to assume.** No run cut an in-flight assistant message short — the first reply always completed before the steered user message appeared, the same caveat OW-tifuha carries for Codex. No turn called a tool, so Pi's documented "deliver after the current tool batch" is unexercised on the case it describes: filed as **OW-nufitu**. `streamingBehavior: "followUp"` was never sent, because the adapter never sends it, so what Pi would do with one is inference. And the model pin's `:high` is confirmed in argv only — the wire spelling drops it.

The card's conditional did not fire: it gated a `defect` card on the prompt being queued or dropped, and it was neither.

Also filed from this work: **OW-yehisa**, `agentpane_pi_smoke.py` still resolving its model from the mutable settings file rather than a flag, which `AGENTS.md` says the flag exists to make impossible.
