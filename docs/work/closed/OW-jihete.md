---
labels: [change, unverified, now]
---

# What Claude Code does with a mid-turn prompt has never been observed, and D16 needs it settled before the adapter is changed either way

`src/server/adapters/claude/adapter.ts` — the module docblock's "CLI queues stdin messages sent mid-turn, so `submit()` does not gate", and `submit` at `:188-202` ("Admission is the stdin write; the CLI queues messages sent mid-turn"); `src/server/adapters/claude/reducer.ts`, `beginTurn` at `:144`; `docs/MANUAL_TESTING.md`, the OW-yilabe control-channel table.

D16 makes a mid-turn `submit()` mean *steer*, and requires an adapter whose backend cannot steer to reject rather than do something else.
Which side of that Claude falls on is **not known**, and this card was first filed asserting it was the rejecting side.
That assertion is withdrawn; establishing the fact is now the card's first job.

Two stacked inferences sit under the original claim, and neither has ever been observed.

**That a stdin message sent mid-turn is queued at all.**
The only sources are two comments in this one file, `:13` and `:198`, which is the repo quoting itself.
No run in `docs/MANUAL_TESTING.md` sends Claude a mid-turn prompt — not the OW-yilabe surface probe, not the OW-beripo live run.

**That Claude Code has no steer primitive.**
The control channel *was* enumerated, by sending unknown subtypes and reading `"Unsupported control request subtype: …"` back, and the probe covered `rewind`, `fork`, `checkpoint`, `list_checkpoints`, `resume` and `status`.
It never tried a steering one.
So a missing steer subtype is untested rather than observed, and the CLI models queued messages explicitly enough to make the question live: `init` advertises `interrupt_receipt_v1`, `interrupt_cancel_queued_v1` and `msg_lifecycle_v1`, and the `interrupt` reply carries `still_queued`.
A queue whose entries can be individually cancelled is a richer surface than "writes land after the turn".

Nothing about this needs the work laptop: only Pi is confined there, and Claude Code runs on the home server pinned to Haiku (`AGENTS.md`, "Evidence" — `claude --model haiku`).

## Done when

First, the observation, recorded in `docs/MANUAL_TESTING.md`:

- A run drives a long turn, writes a user message to stdin while it is streaming, and records **where that text lands** — inside the running turn, or in a new turn after it — and **when** it is delivered relative to the first `result`.
- The same run tries a steering-shaped control subtype and records whether the CLI answers `"Unsupported control request subtype"` by name, the way the OW-yilabe probe established the rest of the surface.
- A fixture for the mid-turn prompt lands under `resources/fixtures/claude/` with its `.meta.json`, scrubbed per `resources/fixtures/README.md`. None exists today.

Then, and only then, one of two changes — phrased over the finding, not over the outcome expected:

- **If the prompt is queued and no steer exists**, the adapter throws when a turn is active, the way Codex's `TURN_ACTIVE_ERROR` guard does, with a test in `claude/adapter.test.ts` that goes red first; the module docblock's "so `submit()` does not gate" and the D16-overturns note now beside it both go, replaced by what was observed.
- **If the prompt reaches the running turn**, Claude already honours D16, nothing in the adapter changes, and the work is to say so: retire the same two comments, and amend D16's line naming this card, which currently reads Claude as a backend that must be made to reject.

Either way the gate question below is answered, and OW-toyeru is settled.

**The `turnActive` flag is not a reliable gate and this is where that gets checked.**
`adapter.ts:418` clears it on the first `result`, which is precisely what OW-toyeru's second half puts in question: if it goes false while a queued turn is still pending, a prompt sent in that window passes any gate built on it and is queued after all.
Settle the flag's accuracy here, not after.

**OW-toyeru waits on this card** (re-pointed from OW-rifezo) and its fate follows the finding.
It is the transcript-ordering defect of a queued mid-turn prompt — `beginTurn` pushes the local user echo at write time, before the running turn's remaining assistant messages.
If mid-turn queueing stops, nothing is misordered and it is moot; close it `--moot` naming this card.
If Claude turns out to steer already, the echo ordering is a live defect that this card does not fix, and OW-toyeru stays open on its own terms.
Say which, with the reasoning, rather than letting it lapse.

Claude Code 2.1.267 on explicit --model haiku queued a mid-turn stdin prompt until after the first result and rejected a steer control request as an unsupported subtype. The live stream and timing provenance are recorded in resources/fixtures/claude/mid-turn.jsonl and its metadata, with host configuration replaced by structural placeholders and account telemetry nulled after adversarial review. ClaudeAdapter now rejects submit and compact while a turn is active; focused adapter tests went red before the guard and green after it, and bun run check passed 48 files and 960 tests. D16, MANUAL_TESTING, fixture guidance, and source comments now carry the observed result. The queued-prompt ordering premise was eliminated, so OW-toyeru was closed moot.
