# Backends

What each backend CLI was measured to do, and on which version.
Each fact carries the version it was measured on (`AGENTS.md`, "Evidence"), and D18 says which ones are defended against time.
The run-by-run evidence is in `docs/MANUAL_TESTING.md`; the findings that established the design are its "HANDOFF findings 1–49".

## Pi

### Fork

Pi fork behaviour, first measured on the work laptop (2026-08-20, `pi 0.84.2`) and re-measured on the home server twice on 2026-09-15 (`pi 0.85.1`) and twice on 2026-10-14 (`pi 1.2.0`), on `deepseek/deepseek-v4.1-flash`: forking at a user message is exclusive of that message, and forking during a streaming turn succeeds while the turn stops — `isStreaming` goes false and `agent_settled` arrives.
Streamed text is **not** discarded: on the second 0.85.1 run, with the probe cell holding the fork until forty `text_delta`s had accumulated and re-reading the count at the instant the request went out, 47 deltas were on the wire and the file the turn was streaming into held the reply's first 447 characters (OW-sededi), and the two 1.2.0 runs read 55 and 53 deltas and 551 and 519 characters (OW-vijine).
So what the fork costs is the rest of the reply and the branch it was on, not the bytes already written.
The empty assistant entry the first 0.85.1 run read in that file was a fork that landed about 2.2s in, before any text existed; that run gated on `agent_start` alone and could not tell the two apart, and the 0.84.2 run earned even less — it forked at the first user message, where exclusivity empties the new branch whatever became of the turn, and never opened the streamed-into file.
The 0.85.1 and 1.2.0 runs also read the fork's moved-to session file as already on disk when `fork` returned, carrying the rewound prefix — samples at the instrument that had once read `false`, and all of them forks at the second user message.
A fork at the first user message keeps no user or assistant message, and on `pi 1.2.0` its file was not on disk when `fork` returned and was written with the branch's first user message (OW-tigaye).
As of `pi 0.87.1`, and in three runs on `pi 1.2.0`, the abandoned turn's last events, `agent_settled` among them, all arrived before the `fork` response, and nothing arrived between it and the `get_messages` answer that followed (OW-dutute), which is why `hydrateMessages` may replace the transcript.
See `docs/MANUAL_TESTING.md` OW-sededi, OW-gajesu and OW-vijine, and OW-yudoni for what the earliest run did and did not show.

On `pi 1.5.2` (home server, 2026-11-19, `deepseek/deepseek-v4.1-flash`), a stop sent to a session with no turn running, `clear_queue` and then `abort`, answered both with `success: true`, `clear_queue` with both queues empty, and Pi wrote nothing else but one `queue_update` naming both queues empty; a `fork` at the first user message after it succeeded and moved `sessionFile`.
That is the stop `PiAdapter.fork` sends ahead of every fork (D30), and `resources/probes/pi_idle_stop_fork_probe.py` repeats the run; see `docs/MANUAL_TESTING.md`, "A Pi stop with no turn running".

### RPC framing

**Pi RPC framing is LF-only.**
Split on `\n` only; do not use Node `readline` (it also splits on U+2028/U+2029, which are valid inside JSON strings).
See Pi's `docs/rpc.md` "Framing".

## Claude Code

### A message written mid-turn

Claude Code mid-turn handling settled live on the home server (2026-09-10, `claude 2.1.267`, explicit `--model haiku`): a stream-json user message written during a turn is acknowledged only after the first `result` and runs as a second turn, while a `steer` control request errors as unsupported.
The adapter therefore rejects `submit()` and `/compact` while a turn is active; see `docs/MANUAL_TESTING.md` OW-jihete.

### A fork spawned mid-stream

Claude Code mid-stream fork behaviour settled live on the home server (2026-09-11, `claude 2.1.268`, explicit `--model haiku`): sampled at four marks spanning 41 to 160 text deltas and again at `result`, the parent's store gains no assistant content until after the turn ends, so a kill mid-turn loses all of it — but the parent turn itself survives a fork spawned as a second child and writes its whole reply durably.
The loss is agentpane's kill, not the CLI's; see `docs/MANUAL_TESTING.md` OW-japuzo.
