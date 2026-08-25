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
  translation ever was. Streaming assembly from `stream_event` deltas;
  treat the completed message event as authoritative, like Codex's
  `item/completed`.
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
