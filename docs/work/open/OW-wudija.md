---
labels: [unverified]
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
