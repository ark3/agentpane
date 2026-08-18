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

The by-key substitution above cannot see operator data a backend replays into
*content* — Codex folds the host's skills manifest into the turn context, so a
fork capture carries the operator's home path and private `SKILL.md` list in
message text and in the `host_skills` world-state block. `fork_probe.py`
therefore also blanks those in place (`scrub_content`), replacing the manifest
with a placeholder while leaving the fork lineage and the post-fork turn intact.

Nothing should ever assert on a scrubbed value. If you need the real ones
locally, `capture_fixtures.py --no-scrub` — but do not commit that output.

## Scenarios

| Scenario | Prompt intent | Covers |
|----------|---------------|--------|
| `text` | reply with a fixed string | streaming text deltas, no tools |
| `tool-read` | read a file and summarise it | tool call + tool result pair |
| `tool-edit` | append a line to a file | file change / diff path |
| `compact` | prime the context, then compact it | manual compaction command + its events (OW-72) |
| `fork` | fork/clone from a past point, then take a turn | fork-from-past on-disk residue and lineage (OW-mewiga) |

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
deterministically: `mcpToolCall`, `dynamicToolCall`, `webSearch`, `plan`.
Add scenarios when you implement those mapping rows.

## The compact scenario (OW-72, captured 2026-08-18)

`compact` primes the context with several long turns and then drives the
backend's manual compaction, so the fixture carries the compaction wire shapes
both adapters reduce against. It is a two-phase capture, and it needed one
non-obvious step per backend:

- **Codex** (`compact.jsonl`, 5247 lines): after the priming turns settle the
  harness sends `thread/compact/start` (params `{ threadId }`, response `{}`),
  which Codex runs as its own non-steerable turn. The fixture contains a
  `contextCompaction` `item/completed` — the item carries *no* summary and *no*
  token figure, only `{ type, id }` — and `thread/tokenUsage/updated` shows the
  drop: total `totalTokens` went **16802 → 9231** across the compaction. The
  adapter maps `contextCompaction` to a bare `compactionSummary` marker.
- **Pi** (`compact.jsonl`, 3587 lines): Pi refuses to compact a session that
  still fits inside `keepRecentTokens` ("Nothing to compact (session too
  small)"; default 20000, verified against 0.84.2's `prepareCompaction`), so
  the capture lowers `keepRecentTokens` in the *throwaway* state dir before
  priming. The successful `compaction_end` carries `{ summary,
  firstKeptEntryId, tokensBefore: 17660, estimatedTokensAfter: 4040, usage,
  details }`. Pi does **not** re-emit the summary through
  `message_start`/`message_end`, so the reducer synthesises the
  `compactionSummary` message from `compaction_end` itself.

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

## The fork scenario (OW-mewiga, captured 2026-08-18)

Not produced by `capture_fixtures.py` but by `../probes/fork_probe.py`, which
ran the first fork on either backend. Each `fork.jsonl` is a session that was
branched into and then had a real turn driven inside it, so the lineage marker
and the post-fork turn are both present:

- **Pi** (`pi/fork.jsonl`): a `clone` of an active branch (whole branch copied
  to a new file), switched into, then continued. The header carries
  `parentSession` pointing at the file it was cloned from. Pi's `fork` is
  copy-on-write on 0.84.2, so the abandoned branch survives as its own intact
  file rather than as an in-file sibling (HANDOFF 43–44).
- **Codex** (`codex/fork.jsonl`): a `thread/fork` through an earlier turn,
  continued with a real turn. The `session_meta` header carries
  **`forked_from_id`** (snake_case) — the on-disk mirror of the protocol's
  `Thread.forkedFromId` (finding 21) — pointing at the parent thread (HANDOFF
  45). `thread/rollback`, the in-place rewind, is deprecated and unused
  (HANDOFF 46), so there is no Codex-rewind fixture: that cell is a documented
  absence, not a capture.

## Determinism

Model output varies between runs. Assert on **structure** — event sequence,
item types, content-block kinds, correlation by id — not on exact assistant
text. The prompts are chosen to keep shape stable, not wording.
