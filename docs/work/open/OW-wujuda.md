---
labels: [defect]
---

# Five of six Codex fixtures were captured on 0.147.0 against an installed 0.154.0, across a wire change the repo has already recorded

`resources/fixtures/codex/` -- `compact`, `fork`, `text`, `tool-edit` and `tool-read` all carry `cli_version: "codex-cli 0.147.0"` in their `.meta.json`; `subagent` is on `0.153.4`. The home server has `codex-cli 0.154.0` installed as of 2026-09-11.

This is not a hypothetical gap.
`docs/MANUAL_TESTING.md` records, from the OW-gojado run, that on `0.154.0` the `agent_message` event is gone, replaced by `event_msg`/`item_completed`, and a `token_usage_record` line type appears that the fixture does not have.
So the repo already knows these fixtures encode a wire shape the installed CLI no longer produces, and the tests that read them are asserting against it.

## Why this is filed as a defect rather than left to age

D18 allows most backend facts to rot and be corrected on contact.
Fixtures are the exception in kind: they are not prose a reader can discount, they are inputs the test suite treats as ground truth, so a green `bun run check` actively asserts the old shape is current.

## Done when

The Codex fixtures are re-captured on the installed CLI with `resources/probes/capture_fixtures.py`, their `.meta.json` provenance reflects the version actually used, and `bun run check` passes against them -- with any test that had to change named, because a test that needed editing to accept the new capture is the finding, not a chore.

The census delta between old and new is recorded in `docs/MANUAL_TESTING.md`.
`OW-pukado` is building the tooling that produces that delta; if it has landed, use it and this card is its first real exercise, and if it has not, do the comparison by hand rather than blocking on it.

Whatever the re-capture shows, record what it means for the scrub guard `OW-demuwi` left behind: a fresh capture is a fresh opportunity to leak account telemetry, and that guard is what should catch it.

This needs a live Codex run on the home server -- `codex -m gpt-5.6-luna` per AGENTS.md -- and no work-laptop trip.
