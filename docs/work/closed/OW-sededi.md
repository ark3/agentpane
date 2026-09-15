---
labels: [unverified]
closed: done
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
The Pi RPC event to accumulate is `message_update` carrying an `assistantMessageEvent` of type `text_delta`, which is what the adapter's own reducer counts as streamed assistant text (`src/server/adapters/pi/reducer.ts`, and `reducer.test.ts` "goes streaming after agent_start"); `PiSession` in the probe already buffers every raw line, so the count is a filter over `self.raw`.
Confirm that against the live stream rather than taking it from here.

Then one run of `python3 resources/probes/fork_probe.py --backend pi --no-fixtures` on the home server, with the observed pre-fork text count and the resulting abandoned-file contents written up in `docs/MANUAL_TESTING.md`, naming the `pi` version it measured.

Whichever way it comes out, the narrowed sentences land on that answer: the bullet in AGENTS.md under "Evidence" beginning "Pi fork behaviour, first measured on the work laptop", the paragraph in `docs/DESIGN.md` D15 under "**Pi leaves no choice.**", the comment in `src/client/controller.ts` `forkAndSubmit` beginning "Pi is that backend", and the OW-gajesu section of `docs/MANUAL_TESTING.md`.
If the run shows text streaming and then vanishing, those stop hedging; if it shows the fork consistently landing before any text exists on this model, they say that instead, and D15's justification is re-read rather than assumed.

## Close note

The `pi_rewind` cell now carries its Codex sibling's streaming discipline, and the run it enabled overturned what the repo had recorded.

**The gate.** `PiSession` gained `stream_deltas`, `await_streaming` and `still_streaming`, mirroring `CodexSession`'s.
The mid-stream path waits for `agent_start` plus forty accumulated `message_update` events whose `assistantMessageEvent.type` is `text_delta` — forty rather than the Codex cell's five for the reason `claude_fork_probe.py` uses forty — re-reads the count and the settle at the instant the `fork` request goes out, records both plus a census of every delta kind, and reports `midstream_result`, which `main()` now reads for the exit status alongside the Codex cell's `result`.
The census is recorded rather than assumed so that a Pi release which streams text under some other event says so instead of timing out silently.

**Watched red first.** With the threshold raised to an unreachable 100000 and nothing else changed, the turn settled before the fork: `midstream_streaming_confirmed_before_fork: false` at 134 deltas, `midstream_still_streaming_at_the_fork_itself: false`, `midstream_result: "unearned"`, probe exit 1.

**The finding: Pi's mid-stream fork does not discard streamed text.**
Home server, 2026-09-15, `pi 0.85.1` on `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"`, `python3 resources/probes/fork_probe.py --backend pi --no-fixtures`, exit 0.
47 `text_delta`s were on the wire at the instant the fork request went out, still streaming, and the file the turn was streaming into holds the reply's first 447 characters (`midstream_abandoned_tail_chars`) where the OW-gajesu run had read `""`.
That empty entry was a fork landing about 2.2s in, before any text existed — exactly the case the missing gate could not distinguish.
The turn still stops.
So what a mid-stream fork costs is the rest of the reply and the branch it was on, not the bytes already written.
Write-up: `docs/MANUAL_TESTING.md`, "Pi's mid-stream fork, measured against text known to have streamed (OW-sededi)".

The narrowed sentences landed on that answer: the AGENTS.md "Evidence" bullet, `docs/DESIGN.md` D15, the OW-gajesu section, `src/client/controller.ts` `forkAndSubmit`, the probe's module docstring and `resources/probes/README.md`.
Two bounds are recorded and not closed: nothing was read from the streamed-into file *before* the fork, so whether the prefix was already on disk mid-stream or flushed when the fork cut the turn is unmeasured; and it is one model's sample.

**The card's conditional fit neither branch** — the run showed text streaming and *surviving*, not vanishing and not absent — so the decision it gated went to a new card: **OW-lukaju**, whether the "Stop and ..." warning's framing should change now that the loss is partial and the remainder is on disk.
D15's decision itself is unchanged and not waiting on it; its cost sentence points there.

Review caught two things in the dispatched work: `midstream_min_deltas_required` was a second literal that reported 40 while a run enforced 100000 (bound to one name, and re-verified live), and a second agreeing run whose log had been overwritten is now cited as transcript-only rather than as a record.
Commits d5e776a, 8a42db9, 572aeac, 7250419; `bun run check` passes on `main` (50 files, 1094 tests).
