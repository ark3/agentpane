# Protocol fixtures

Recordings of what each backend emits during one turn. These exist so the
`ThreadItem` -> `AgentMessage` mapping — the only real engineering in this
project — can be built and tested **offline**, with no live model calls in the
test suite.

Regenerate with:

```bash
python3 ../probes/capture_fixtures.py                  # everything
python3 ../probes/capture_fixtures.py --backend codex --scenario tool-edit
```

Each capture writes two files:

- `<scenario>.jsonl` — every line the backend wrote to stdout, in order,
  byte-for-byte except for the scrub below. This is the test input.
- `<scenario>.meta.json` — provenance: CLI version, capture time, the prompt,
  an event-type census, and whether the turn terminated cleanly.

## Scrubbed values

These files get committed, so the harness replaces values that identify the
operator's infrastructure with structurally-equivalent placeholders —
`example-model`, `example-provider`, `example-api-stream`,
`example-mcp-server`, and a generic user agent. The substitution is by JSON
key (`model`, `provider`, `modelProvider`, `api`, `serverName`, `userAgent`),
so tool names like `bash` and `read` are untouched and remain assertable.

Nothing should ever assert on a scrubbed value. If you need the real ones
locally, `capture_fixtures.py --no-scrub` — but do not commit that output.

## Scenarios

| Scenario | Prompt intent | Covers |
|----------|---------------|--------|
| `text` | reply with a fixed string | streaming text deltas, no tools |
| `tool-read` | read a file and summarise it | tool call + tool result pair |
| `tool-edit` | append a line to a file | file change / diff path |

## What was captured (2026-08-10, pi 0.84.1 / codex-cli 0.147.0)

| | text | tool-read | tool-edit |
|---|---|---|---|
| Pi | 14 lines | 33 lines | 42 lines |
| Codex | 24 lines | 60 lines | 143 lines |

**Pi** exercised `text`, `thinking`, and `toolCall` content blocks, with
`stopReason` of both `stop` and `toolUse`. Tools used: `read`, `bash`. Note
Pi chose `bash` for the edit rather than a dedicated edit tool — do not assume
a fixed tool vocabulary.

**Codex** exercised five `ThreadItem` types: `userMessage`, `reasoning`,
`agentMessage`, `commandExecution`, `fileChange`. Reasoning items appear even
in the `text` scenario. Still uncovered, because they are hard to trigger
deterministically: `mcpToolCall`, `dynamicToolCall`, `webSearch`, `plan`,
`contextCompaction`. Add scenarios when you implement those mapping rows.

## Two things the captures proved

**Codex really does send approval requests.** `tool-edit` contains a live
`item/fileChange/requestApproval` server request, answered by the harness,
followed by `serverRequest/resolved`. DESIGN D2a is therefore not theoretical.
What remains unverified is whether sbox's injected `--sandbox
danger-full-access` suppresses them — these captures do **not** run through
sbox (see the harness docstring for why).

**Codex emits more than DESIGN's mapping table lists.** Beyond `item/*` and
`turn/started|completed`, the captures contain `turn/diff/updated` (a
cumulative turn diff, 4x during `tool-edit`), `thread/tokenUsage/updated`,
`thread/status/changed`, `thread/started`, `account/rateLimits/updated`,
`mcpServer/startupStatus/updated`, and `remoteControl/status/changed`. Several
are directly useful — token usage for cost display, status changes for the
streaming signal. Read a fixture before assuming the mapping table is
exhaustive.

## Determinism

Model output varies between runs. Assert on **structure** — event sequence,
item types, content-block kinds, correlation by id — not on exact assistant
text. The prompts are chosen to keep shape stable, not wording.
