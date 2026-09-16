---
labels: [defect]
---

# Five of six Codex fixtures were captured on 0.147.0 against an installed 0.154.0, and nothing has measured whether the wire moved

`resources/fixtures/codex/` -- `compact`, `fork`, `text`, `tool-edit` and `tool-read` all carry `cli_version: "codex-cli 0.147.0"` in their `.meta.json`; `subagent` is on `0.153.4`. The home server has `codex-cli 0.154.0` installed as of 2026-09-11.

## What is and is not known

The gap is the version stamp, and only that.
One shape change across these versions is on record, but it is in a different artifact: `docs/MANUAL_TESTING.md` records from the OW-gojado run that the **rollout file on disk** on `0.154.0` drops the `agent_message` event for `event_msg`/`item_completed` and gains a `token_usage_record` line.
The only rollout fixture is `fork.jsonl`, and no Codex reducer test reads it; the other five fixtures are app-server JSON-RPC event streams, a separate wire.
On that wire the one data point already in the repo points the other way: `subagent.meta.json`, captured on `0.153.4`, carries the same event-type set as the `0.147.0` `text` capture.
So whether the tests are asserting a shape the installed CLI no longer produces is open, and this card's first job is to find out rather than to assume.

## Two drifts already seen on the request side, 2026-09-15

Both came out of the session-name work (`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire") and are the vendored bindings under `resources/codex-protocol/v2/` disagreeing with `codex-cli 0.154.0`, not fixture drift; they are recorded here because this is the card asking whether the wire moved.
The rename method is `thread/name/set`: `thread/setName`, the spelling `ThreadSetNameParams.ts` implies, was rejected with `-32600 unknown variant` and a list of every method the server accepts, and `thread/name/updated` is the matching notification.
A `thread/list` row carries `model` (`"gpt-5.6-luna"` in that run) and `reasoningEffort`, neither of which `Thread.ts` declares.
Whatever the fixture diff shows, record what it means for re-vendoring the bindings: the method census in `docs/HANDOFF.md` finding 48 counted 133 client methods on the schema it was taken from, and the 0.154.0 rejection listed 162.

## Why this is filed as a defect rather than left to age

D18 allows most backend facts to rot and be corrected on contact.
Fixtures are the exception in kind: they are not prose a reader can discount, they are inputs the test suite treats as ground truth, so a green `bun run check` actively asserts the old shape is current.
D18 splits that into two claims and gives the second one -- that the installed CLI still produces the shape -- a live run rather than a re-capture.
This card is the first such run.

## Done when

The event types a live turn on the installed CLI produces have been diffed against the newest fixture for each scenario, and the delta is recorded in `docs/MANUAL_TESTING.md` with the version on both sides.
`OW-pukado` is building the tooling that prints that delta; if it has landed, use it and this card is its first real exercise, and if it has not, do the comparison by hand rather than blocking on it.

Then, for each scenario whose delta shows a type added or removed, and only those, the fixture is re-captured with `resources/probes/capture_fixtures.py`, its `.meta.json` reflects the version actually used, and `bun run check` passes against it -- with any test that had to change named, because a test that needed editing to accept the new capture is the finding, not a chore.
Count drift alone re-captures nothing.
If no scenario shows a type change, the outcome is a recorded delta and untouched fixtures, and that is a complete close.

Whatever a re-capture shows, record what it means for the scrub guard `OW-demuwi` left behind: a fresh capture is a fresh opportunity to leak account telemetry, and that guard is what should catch it.

This needs a live Codex run on the home server -- `codex -m gpt-5.6-luna` per AGENTS.md -- and no work-laptop trip.
