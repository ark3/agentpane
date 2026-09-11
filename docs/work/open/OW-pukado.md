---
labels: [change]
---

# The fixture censuses are a conformance baseline nothing compares against, so a backend version bump reports no wire changes at all

D18 makes the census diff the change report for a version bump.
Today the baseline exists and the comparison does not, so producing it is a manual read of two JSON blobs.

`resources/fixtures/*/*.meta.json`, `resources/probes/capture_fixtures.py`, `resources/fixtures/README.md`.

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

Re-capturing a scenario against a different CLI version reports the census delta -- event types added, removed, and counts materially changed -- rather than silently overwriting the old meta.
Whether that is a flag on `capture_fixtures.py`, a separate comparison entry point, or part of the capture's normal output is the implementer's call; the observable is that the delta is printed without anyone opening two files.

A test covers the comparison itself against two synthetic censuses, since the real one cannot be exercised without a live run.

`resources/fixtures/README.md` says what the census is for, so the next person to bump a CLI knows the diff exists.

Note the counts are noisy by nature -- delta events scale with reply length and the same prompt does not produce the same token stream twice. Distinguishing a type that vanished from a count that drifted is the substance of this card, not an afterthought; a comparison that reports every count change will be ignored within two bumps.
