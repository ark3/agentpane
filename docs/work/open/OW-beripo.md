---
kind: change
where: '`src/server/adapters/claude/` (new); template `src/server/adapters/codex/`'
---

# A Claude Code adapter behind the frozen `BackendAdapter` contract, driving `claude -p` over stream-json in both directions.

Decided 2026-08-25 by the owner: Claude Code becomes a third backend, and
limited functionality is acceptable — the two first cuts below are decided,
not open. Assumes OW-yilabe (fixtures, and protocol answers appended to this
file as that item records them) and OW-votasi (`BackendId`, enumeration).

Implement `BackendAdapter` (`src/server/adapters/types.ts` — frozen; raise
before editing) as a sibling of the Codex adapter, which is the template for
everything structural: the process/framing/reducer/mapping/adapter file
split, fixture-driven reducer tests (`codex/reducer.test.ts`), synchronous
side-effect-free construction (`AdapterFactory` docblock), idempotent
`dispose()`.

- Spawn: `direnv exec <cwd> sbox -- claude -p --input-format stream-json
  --output-format stream-json --include-partial-messages`, plus
  `--resume <id>` and `--model` per `StartOptions`. sbox's `claude` profile
  already mounts `~/.claude` and injects `--permission-mode
  bypassPermissions` (verified 2026-08-25 via `--dry-run`); spawn cwd rules
  are D7, as the contract's docblock says.
- Framing: NDJSON both directions — `pi/framing.ts` is the nearer template
  than Codex's JSON-RPC layer.
- Reducer: Claude's `assistant`/`user` events wrap Anthropic Message
  payloads, so text/thinking/tool_use/tool_result content blocks map to
  `AgentMessage` nearly 1:1 — closer to identity than Codex's `ThreadItem`
  translation ever was. Streaming assembly from `stream_event` deltas — but
  there is no per-message completion event to treat as authoritative the way
  Codex's `item/completed` is: OW-yilabe found `assistant` events arrive per
  completed content block, merged by API `message.id`, and only `result` ends
  the turn (details in the answers below).
- `abort()`, `setModel()`, `compact()`, `listModels()`: per the answers
  OW-yilabe records here.
- Tool rendering should come mostly free: `registry.ts` matches
  bash/read/edit/write case-insensitively, so Claude's Bash/Read/Edit/Write
  hit the bespoke renderers — but check `render/tools/args.ts`'s expected
  argument shapes against Claude's (`old_string`/`new_string` for Edit,
  captured in OW-yilabe's tool fixture), and let everything else (Task, Glob,
  WebSearch, `mcp__*`) land on D5's default card, which exists for exactly
  this.
- Wire-up: factory in `composition.ts`; `<option value="claude">` in
  `App.svelte` (~line 863), deliberately left out of OW-votasi so the picker
  never offers a backend that cannot attach.

First cuts, decided 2026-08-25:

- Fork is tip-only or absent, per what OW-yilabe records about
  `--fork-session`; `listForkPoints` may return only the tip. Whatever
  residue this leaves becomes its own item at close.
- `onRequest` is inert: sbox injects `bypassPermissions`, and the jail is the
  confinement boundary — the same rationale DESIGN records for Codex's
  `danger-full-access`. Surfacing `can_use_tool` as an `AgentRequest` is a
  later item, filed at close against the shape OW-yilabe captures; OW-bijera
  is the client half of that story.

Done when: reducer and adapter tests over OW-yilabe's fixtures fail before
the change and pass after, and `bun run check` is green; a live Haiku session
driven from the UI on the home server shows a full turn — user text, streamed
assistant text, a tool call/result pair rendered — recorded in
`docs/MANUAL_TESTING.md`. The landing change also retires DESIGN.md's "Two
backends behind one adapter contract" phrasing wherever it appears, per the
retire-every-copy rule. OW-24 (no browser E2E over a real backend turn) is
related, not absorbed: this item does not add a Playwright scenario.

## Answers from OW-yilabe, 2026-08-25

Live evidence in `docs/MANUAL_TESTING.md` (OW-yilabe section), fixtures under
`resources/fixtures/claude/`, all on `claude 2.1.238` / Haiku. One line per
checklist item, stated as the consequence for this adapter:

- Spawn: drop `--verbose` from the invocation — 2.1.238 streams without it.
  The working shape is `claude -p --model haiku --input-format stream-json
  --output-format stream-json --include-partial-messages`.
- `init` / identity: session id, resolved model id, permission mode, and the
  tool list all come from the first stream line; parse it, nothing to poll.
- `listModels()`: send a `control_request` subtype `initialize` after spawn —
  its response carries `models` (value, resolvedModel, displayName,
  description, effort support). `init` alone does not list models. Do not
  fixture the response: it carries the operator's account email.
- `abort()`: `control_request` subtype `interrupt` works mid-stream; expect a
  `control_response` success, then a `result` with subtype
  `error_during_execution`, `is_error: true`, and process exit 1 on a lone
  `-p` turn — treat that result as "aborted", not as a failure. Fixture
  `interrupt.jsonl`.
- `setModel()`: `control_request` subtype `set_model` exists mid-session and
  validates the model id (bogus ids error) — no respawn-with-resume needed.
  Its effect on a later turn is unverified (proving it needed a non-Haiku
  turn, outside the authorization); if it disappoints, respawn with
  `--resume` is the fallback.
- `compact()`: send the literal text `/compact` as a stream-json user
  message. Reduce `system`/`compact_boundary` (`compact_metadata` has
  `pre_tokens`/`post_tokens`) to the `compactionSummary` marker; the summary
  text arrives as a user message, and the closing `result` has
  `num_turns: 0`. Fixture `compact.jsonl`.
- `fork` / `listForkPoints`: tip-only, as the first cut assumed — respawn
  with `--resume <id> --fork-session`. It mints a new session id and copies
  the whole history into the new store file with **no lineage marker**, so if
  the UI ever wants parentage the adapter must record it itself. No pre-tip
  fork exists headless (no rewind/fork/checkpoint control subtypes;
  `--resume` takes no message index). Fixture `fork.jsonl`.
- Enumeration (OW-votasi): headless `-p` turns do write
  `~/.claude/projects/<munged-cwd>/<session-id>.jsonl`, so adapter-driven
  sessions are enumerable; `--session-id <uuid>` lets the adapter choose the
  id at spawn. Fixture `session-id.jsonl`.
- `onRequest` (deferred, filed against a recorded shape now): the ask only
  appears if the CLI is spawned with the undocumented
  `--permission-prompt-tool stdio`; it is a CLI-initiated `control_request`
  subtype `can_use_tool` (tool_name, full `input` including Edit's
  `old_string`/`new_string`, `permission_suggestions`, `tool_use_id`),
  answered by a `control_response` whose inner response is
  `{behavior: "allow", updatedInput}`. Under sbox's injected
  `bypassPermissions` none of this fires, so inert `onRequest` stands.
  Fixture `permission-request.jsonl`.
- Reducer: Haiku emits thinking blocks headless on every turn, so thinking
  rendering is day-one, not optional. `assistant` events are per content
  block under one API `message.id` — merge by id; the completed-message
  authority the Codex template leans on is the block-level event here.
  Multiple `message_start`/`message_stop` cycles occur inside one logical
  turn (one per API round-trip); only `result` ends the turn. Tool inputs
  match `render/tools/args.ts` expectations (Bash `{command, description}`,
  Read `{file_path}`, Edit `{replace_all, file_path, old_string,
  new_string}`).
