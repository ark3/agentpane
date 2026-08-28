---
labels: [unverified]
---

# Every stream-json surface the Claude Code adapter needs is believed from `--help`, never proven; one capture visit settles the list and leaves fixtures.

`resources/fixtures/claude/` (new), evidence into `docs/MANUAL_TESTING.md`

**Home server:** needs live `claude` turns — authorized by the owner
2026-08-25, **Haiku only** (`--model haiku`). No work-laptop trip: unlike Pi
and Codex, `claude` (2.1.238 today) is installed where the server runs.

The owner decided on 2026-08-25 to add Claude Code as a third backend
(OW-votasi, OW-beripo). This item is the evidence pass OW-beripo builds on,
and it runs in the one-visit spirit: every question below is answered in the
same sitting, because the second question costs almost nothing while the CLI
is already running.

Already verified on 2026-08-25 and not part of this item: `sbox` has a
`claude` profile, auto-detected by command name, mounting `~/.claude` and
injecting `--permission-mode bypassPermissions` (seen via
`sbox --dry-run claude`); the session store is
`~/.claude/projects/<munged-cwd>/<uuid>.jsonl` with Anthropic-shaped
`message` payloads (OW-votasi carries the store details).

Two deliverables. First, fixtures under `resources/fixtures/claude/`,
following `resources/fixtures/codex/` conventions: a plain text turn, a
thinking turn, a tool-using turn (Bash plus a file edit, so the renderer
question in OW-beripo has real argument payloads to check against), and an
interrupted turn — each the raw NDJSON the CLI emitted, captured with
`--include-partial-messages` so streaming deltas are in the record. Second,
answers in `docs/MANUAL_TESTING.md`, each with the exact invocation that
produced it — the working invocation is itself evidence (for example, whether
`-p --output-format stream-json` still requires `--verbose`).

The checklist. Each line is phrased over the decision it gates: whatever the
answer, record what it means for OW-beripo, in OW-beripo's file.

- The `init` system event: what it carries (session id, model, tools,
  permission mode) — OW-beripo's `listModels` and identity reporting feed on
  it.
- The control channel over stdin: the request/response envelope, and which
  requests exist — interrupt (gates `abort()`), set-model mid-session (gates
  `setModel()` versus respawn-with-resume).
- `/compact` sent as a stream-json user message: whatever happens, that is
  what the contract-required `compact()` wraps.
- Fork: what `--resume <id> --fork-session` produces (new session id, shared
  history on disk?) and whether any pre-tip fork exists headless — this fixes
  the `listForkPoints`/`fork` scope, tip-only being the accepted first cut.
- Whether a headless `-p` turn writes the session store (OW-votasi's
  enumeration must see adapter-driven sessions), and whether `--session-id`
  lets the adapter choose the id.
- One capture under `--permission-mode default`, run outside sbox so nothing
  injects bypass: what a permission request looks like on the stream. Not to
  build the approval flow — deferred, see OW-beripo — but so that deferral is
  filed against a recorded shape rather than a guess.

Done when the fixtures are committed and every checklist line has its answer
in `docs/MANUAL_TESTING.md` plus its consequence written into OW-beripo's
file.

**Fixed** in `1d5db63` and `f956e46`: nine raw stream-json fixtures under
`resources/fixtures/claude/` (text, thinking, tool-use with Bash/Read/Edit,
interrupt, permission-request, compact, fork, control-discovery, session-id),
and every checklist line answered in `docs/MANUAL_TESTING.md`'s OW-yilabe
section with its consequence appended to OW-beripo. Headlines: `--verbose` is
no longer needed; `interrupt` and `set_model` exist on the control channel;
`/compact` works over stream-json; fork is tip-only with no lineage marker
(the accepted first cut stands); headless turns write the store and
`--session-id` picks the id; the permission ask needs the undocumented
`--permission-prompt-tool stdio` and its `can_use_tool` shape is on record;
Haiku emits thinking headless, so the reducer handles thinking day-one. One
finding overturned an OW-beripo assumption — `assistant` events are per
content block, not per message — and `f956e46` retired that claim at its
site.

**Correction, 2026-08-25 (OW-mayuza):** "fork is tip-only" above is
overturned — a pre-tip truncating fork works headless via
`--resume-session-at <uuid>` (with `--resume --fork-session`), a spawn-time
flag `.hideHelp()`'d out of `--help`. This item's probes were accurate but
looked in the wrong places: `--help` (where `--resume` takes only a session
id) and the control channel (rewind/fork/checkpoint subtypes all rejected by
name) — a flag hidden from `--help` is invisible to both, and it surfaced
only when the owner pointed at the VS Code extension's arbitrary-point forks
and the 2.1.238 bundle was grepped. Evidence and semantics (inclusive of the
named store-line `uuid`, unlike Pi's exclusive cut) in
`docs/MANUAL_TESTING.md`'s OW-yilabe section, fixture
`fork-at-message.jsonl`.
