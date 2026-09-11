---
labels: [change]
---

# The fixture censuses are a conformance baseline nothing compares against, so a backend version bump reports no wire changes at all

D18 makes the census diff the change report for a version bump, and places it on a live run rather than on a re-capture: a fixture is a stamped snapshot that is never treated as current, and the claim that the installed CLI still produces its shape is tested by driving a real turn and diffing what arrives against the newest fixture for that scenario.
Today the baseline exists and the comparison does not, so producing it is a manual read of two JSON blobs.

`resources/fixtures/*/*.meta.json`, `resources/probes/agentpane_codex_smoke.py`, `resources/probes/agentpane_pi_smoke.py`, `resources/probes/capture_fixtures.py`, `resources/fixtures/README.md`.

## What is already there

Every capture carries provenance a diff could run on: `cli_version`, `captured_at`, `event_census` (every event type with its count) and `server_requests_seen`.
`resources/fixtures/codex/tool-edit.meta.json` is a representative one.

That is a genuinely good baseline and this card does not redesign it.

## What is missing

Nothing reads a stored census and compares it to a fresh one.
The OW-18/OW-gojado session did exactly this comparison by hand and it produced the most useful line of the whole run -- `docs/MANUAL_TESTING.md` records that on `0.154.0` the `agent_message` event is gone, replaced by `event_msg`/`item_completed`, and a `token_usage_record` line type appears that the fixture does not have.
That is the output this card wants on demand rather than by luck.

`OW-demuwi` is the precedent worth reading: the fixture scrub was also a convention enforced only by a README asking you to grep, and it was converted into a guard that catches the next leak. This is the same move on the same asset.

## Done when

A live turn on the installed CLI reports the census delta against the newest stored fixture for its scenario -- event types added, removed, and counts materially changed -- without anyone opening two files.
The natural home is the smoke scripts, which already drive that turn on demand and are the thing a person runs after a CLI upgrade; a re-capture with `capture_fixtures.py` should print the same delta before it overwrites the old meta.
Whether that is one shared comparison module called from both, or a separate entry point they each invoke, is the implementer's call.

A test covers the comparison itself against two synthetic censuses, since the real one cannot be exercised without a live run.

`resources/fixtures/README.md` says what the census is for and that a fixture is a stamped snapshot rather than a statement about the current CLI, so the next person to bump a CLI knows the diff exists and runs it instead of re-capturing everything.

Note the counts are noisy by nature -- delta events scale with reply length and the same prompt does not produce the same token stream twice. Distinguishing a type that vanished from a count that drifted is the substance of this card, not an afterthought; a comparison that reports every count change will be ignored within two bumps.
