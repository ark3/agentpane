---
labels: [unverified]
closed: done
---

# The five Pi fixtures were captured on 0.84.x against an installed pi 0.87.1, and nothing has measured whether the wire moved

The Pi counterpart of OW-wujuda, filed 2026-09-30 from OW-zadupu, whose pass covered Codex only.

`resources/fixtures/pi/` -- `text`, `tool-read` and `tool-edit` carry `cli_version: "0.84.1"` in their `.meta.json`, and `compact` and `fork` carry `0.84.2`.
`pi --version` on the home server reported `0.87.1` on 2026-09-30.
The gap is the version stamp, and only that: nothing on record says the RPC event stream changed across those versions, and nothing says it did not.

In service of D18's position that a fixture is a stamped snapshot, and that the claim the installed CLI still produces its shape is tested by driving a live turn and diffing what arrives against the newest fixture for that scenario.

## Done when

The event types a live turn on the installed `pi` produces, per scenario in `resources/probes/capture_fixtures.py`, have been diffed against the newest Pi fixture for that scenario, and the delta is recorded in `docs/MANUAL_TESTING.md` with the version on both sides.
OW-pukado is building the tooling that prints that delta; if it has landed, use it, and if it has not, do the comparison by hand rather than blocking on it.

Then, for each scenario whose delta shows an event type added or removed, and only those, the fixture is re-captured with `capture_fixtures.py`, its `.meta.json` reflects the version used, and `bun run check` passes against it, with any test that had to change named.
Count drift alone re-captures nothing, and if no scenario shows a type change, a recorded delta with untouched fixtures is a complete close.

Pi runs only with the pinned model, `pi --model openrouter/deepseek/deepseek-v4.1-flash:high` (AGENTS.md, "Evidence"); `capture_fixtures.py` already passes it (OW-yehisa), and the run needs the home server and no work-laptop trip.

## Amended 2026-10-14: the installed Pi is now 1.2.0

`pi --version` on the home server reported `1.2.0` on 2026-10-14, ten releases past the `0.87.1` this card was filed against, `0.99.0` through `1.2.0` with `1.0.0` among them.
The comparison is now against `1.2.0`, and the delta recorded names it.
Pi's own changelog for those releases is at `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`; read from it on 2026-10-14, no command, response or event type agentpane consumes was removed or renamed, which is a reading, not this card's measurement.
OW-meriva, OW-wavini, OW-zarine, OW-kokotu and the amendment to OW-tigaye, filed the same day, carry the changes that reading did find, so a delta here that names one of them is recorded and left to that card.

## Amended 2026-10-14 at execution: four of the five fixtures are in scope

`capture_fixtures.py` drives four Pi scenarios -- `text`, `tool-read`, `tool-edit` and `compact` -- and those four are what "per scenario" in the done-condition covers.
`pi/fork.jsonl` is not an RPC stream: it is a session file `resources/probes/fork_probe.py` left behind on 0.84.2 (`resources/fixtures/README.md`, "The fork scenario"), so no live turn's event census diffs against it, and whether Pi 1.2.0's session-file shape still matches it is a different measurement this card does not make.
`OW-pukado` is still open on 2026-10-14, so the comparison is by hand.

## Close note

Measured, no fixture re-captured.
On 2026-10-14 the home server ran `python3 resources/probes/capture_fixtures.py --backend pi --scenario text --scenario tool-read --scenario tool-edit --scenario compact --timeout 300` on `pi 1.2.0`, pinned to `openrouter/deepseek/deepseek-v4.1-flash:high` (every run's `models_seen` confirmed it), and diffed each live `event_census` against the committed fixture's (`text`, `tool-read`, `tool-edit` on 0.84.1, `compact` on 0.84.2).
No event type was added or removed in any of the four; all ran `terminated_cleanly` with no dialogs, and `compact` reached `compaction_end` with `reason: "manual"`.
Count drift only: one more `message_start`/`message_end` pair everywhere is Pi's leading system message (OW-wavini's), and the rest is the model (`tool-edit` took an extra `ls -la` turn).
Inside existing types everything was additive: `prompt` response `data.disposition` (OW-kokotu's), assistant `thinkingLevel` (OW-zarine's), plus `durationMs`, `responseId`, `agent_settled.aborted`, `tool_execution_end.result.structuredContent`, `toolcall_start.id`/`toolName`, and `message_update.usage`; `thinking_*` sub-events inside `message_update` appeared but are not census types and the old model is unrecorded.
Verified by the dispatching session with its own script over the saved old and new metas and streams; per the card, a recorded delta with untouched fixtures is the complete close.
The full delta is in `docs/MANUAL_TESTING.md`, "The Pi fixtures' event census on `pi 1.2.0` (OW-wudija)".
`pi/fork.jsonl` was out of scope (a session file from `fork_probe.py`, not an RPC stream), as the 2026-10-14 amendment says; OW-pukado's tooling had not landed, so the comparison was by hand.
A future re-capture of `tool-edit` on 1.2.0 can carry the operator's username in `ls -la` output, which neither the key scrub nor `src/fixture-scrub.test.ts` catches by OW-demuwi's decision; the READMEs' human grep is the stated control, and the MANUAL_TESTING section notes it.
