---
labels: [unverified]
---

# Pi's mid-stream fork cell fires without proving the turn had produced any text

The `pi_rewind` cell in `resources/probes/fork_probe.py` fires its mid-stream `fork` as soon as `agent_start` arrives — the sequence is `prompt`, `wait_for_event("agent_start", timeout=10)`, one `get_state`, then `fork` — so it never establishes that the turn had emitted any assistant text before the fork landed.

Its Codex sibling in the same file does establish it: `codex_fork_mid_stream` calls `await_streaming(..., min_deltas=5, ...)`, which requires `turn/started` plus five accumulating `item/agentMessage/delta` notifications, and the cell records `result: "unearned"` and the probe exits non-zero when either signal is missing.
`resources/probes/README.md` calls that "the streaming discipline" and names `fork_probe.py`'s Codex cell as where it comes from; `resources/probes/claude_fork_probe.py` gates on 40 accumulated deltas for the same reason.
The Pi cell is the one place that discipline is not applied.

## Why it matters

This is what stops the 2026-09-15 home-server run (`pi 0.85.1`, `docs/MANUAL_TESTING.md`, "Pi's mid-stream fork, and the forked file on disk, re-measured at the instrument (OW-gajesu)") from closing the question it was run to close.
That run read the file the abandoned turn was streaming into and found the turn's user message followed by an assistant entry whose text is `""`.
On its face that says a mid-stream fork leaves no reply behind.
But the run's own session-file timestamps put the fork about 2.2 seconds after the prompt, on `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"`, so "the fork discarded the streamed text" and "no text had been produced yet, so there was nothing to discard" are indistinguishable in that record.
The write-up was narrowed to say only what it earned, and this card is the gap it names.

The claim that stays short of proven is the one AGENTS.md states under "Evidence" and `docs/DESIGN.md` D15 turns on: that Pi's mid-stream fork destroys an in-flight turn's output, which is why agentpane's Pi edit path aborts the turn and labels the button "Stop and ...".
`src/client/controller.ts` `forkAndSubmit` is the site `src/client/App.svelte` points readers to for that evidence.
D15 is not in doubt — Pi abandons the turn either way — but "nothing of the reply survives" is currently an inference from an empty entry, not a measurement of text that existed and then did not.

## Done when

The `pi_rewind` mid-stream cell gates on accumulating assistant text the way the Codex cell does — `agent_start` plus a threshold of streaming text deltas observed on the wire before the `fork` request goes out, re-read at the instant it goes out, with the count recorded in the cell's output and a refusal to report a result the run did not earn.
The Pi RPC event whose accumulation counts as that signal is part of the work: `PiSession` in the probe already buffers every raw line, and `rpc.md` on the home server is the reference for which event carries streamed assistant text.

Then one run of `python3 resources/probes/fork_probe.py --backend pi --no-fixtures` on the home server, with the observed pre-fork text count and the resulting abandoned-file contents written up in `docs/MANUAL_TESTING.md`, naming the `pi` version it measured.

Whichever way it comes out, the narrowed sentences land on that answer: the bullet in AGENTS.md under "Evidence" beginning "Pi fork behaviour, first measured on the work laptop", the paragraph in `docs/DESIGN.md` D15 under "**Pi leaves no choice.**", the comment in `src/client/controller.ts` `forkAndSubmit` beginning "Pi is that backend", and the OW-gajesu section of `docs/MANUAL_TESTING.md`.
If the run shows text streaming and then vanishing, those stop hedging; if it shows the fork consistently landing before any text exists on this model, they say that instead, and D15's justification is re-read rather than assumed.
