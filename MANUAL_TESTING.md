# Manual testing — live-run evidence

Live runs that cannot live in the automated suite (they make real model calls
and need the CLIs, credentials, and session corpus of a specific machine). Each
entry says what was run, on what, and what it proved. Re-runnable probes live
in `resources/probes/`.

## Fork-from-past: the 2×2 of {Pi, Codex} × {rewind, new session} (OW-mewiga)

Run on the work laptop, 2026-08-18, **pi 0.84.2 / codex-cli 0.147.0**, by
`resources/probes/fork_probe.py`. Until this, nothing had ever run a fork on
either backend — `DESIGN.md:21` and HANDOFF finding 7 asserted support from
`rpc.md` and the Codex bindings alone. All four cells ran; both corrections to
finding 7 and `DESIGN.md:21` are landed with this work (HANDOFF findings 43–48).

Constraints honoured: every run used a throwaway workspace and a throwaway
state dir (`PI_CODING_AGENT_DIR` / `CODEX_HOME`) with credentials copied in — no
corpus session was ever forked (Pi's fork could rewrite a file in place). Codex
threads were **not** `ephemeral`, because the on-disk residue is the question.
New-session cells end with a completed assistant turn *inside* the fork; rewind
is proven against disk, not against the response (finding 30: a vetoed Pi fork
reports `success: true` with `cancelled: true`).

### Cell 1 — Pi, rewind (RPC `fork`)

- **Exists?** Yes. `{"type":"fork","entryId":…}` → `success: true`,
  `data: {text: "<forked-from message>", cancelled: false}`.
- **Returned?** The text of the user message being forked from, and a
  `cancelled` flag. Nothing about where the rewound branch now lives.
- **Left on disk?** The surprise. The adapter docblock (`pi/process.ts:343`)
  says `fork` "rewinds the active branch of the SAME session file in place." On
  0.84.2 it is **copy-on-write**: the active file is left **byte-identical**
  (sha unchanged; its last entry is still the abandoned `BETA` assistant reply),
  and the post-fork re-ask lands in a **new** file whose header carries a
  `parentSession` pointer back to the original. So the abandoned tail always
  survives — the open question the cell existed to answer. Corroborated by the
  corpus: 81 of 419 Pi session files carry in-file sibling branches under one
  parent id (the TUI `/fork` shape). Both routes preserve; neither destroys.
  **No destructive-rewind warning is warranted.** (HANDOFF 43.)

### Cell 2 — Pi, new session (RPC `clone` + `switch_session`)

- **Exists?** Yes. `{"type":"clone"}` → `success: true`, `data: {cancelled:
  false}`.
- **Highest-value unknown — does `clone` take an entry id? NO.** `rpc.md`
  "clone": it duplicates the *whole active branch* into a new session at the
  current position; there is no per-entry parameter. Branching into a new
  session from a chosen point on Pi is therefore a composition — `fork` (rewind)
  then `clone`, or `clone` then `switch_session` into the copy.
- **Returned / left on disk?** A new session file appears (whole active branch
  copied) with a `parentSession` lineage pointer. The RPC process does **not**
  auto-switch to it: `get_state` still reports the original file. The probe
  `switch_session`s into the clone and drives a real turn — assistant replied
  `EPSILON`, clone grew to 9 entries, original untouched. (HANDOFF 44.)

### Cell 3 — Codex, new session (`thread/fork` with `lastTurnId`)

- **Exists?** Yes, wired and used by the adapter (`codex/adapter.ts:391`).
  `thread/fork` with `lastTurnId` (inclusive) → a new thread id.
- **Returned?** A `Thread` with a fresh `id`, `forkedFromId` set to the parent,
  and its own `sessionId`. The probe drove a real turn in the fork — assistant
  replied `GAMMA` to a completed `agentMessage` item.
- **Left on disk?** A new rollout file whose `session_meta.payload` carries
  **`forked_from_id`** (snake_case) pointing at the parent — the on-disk mirror
  of the protocol's `Thread.forkedFromId` (finding 21). The parent rollout is
  untouched. In the corpus, 21 of 597 files carry `forked_from_id` — `source:
  cli` / `thread_source: user` for real user forks, plus a `subagent` variant.
  (HANDOFF 45.)

### Cell 4 — Codex, rewind (`thread/rollback`) — UNAVAILABLE, by design

- **Exists?** The method is still in the 0.147.0 schema, but its
  `ThreadRollbackParams` description reads verbatim: **"DEPRECATED:
  `thread/rollback` will be removed soon."** Its own docstring warns it edits
  only history and does not revert file changes.
- **Returned / left on disk?** Not fired — firing a deprecated command that is
  slated for removal proves nothing durable, and the adapter deliberately never
  calls it (`codex/adapter.ts:370`). The probe records the deprecation from the
  live schema instead.
- **Result:** *Codex cannot rewind in place.* There is no non-deprecated
  replacement. Rewind on Codex is expressed as a new-session fork through an
  earlier turn (Cell 3) — which is exactly the adapter's design. This is a
  reported result, not a probe failure. (HANDOFF 46.)

### Artifacts

- Probe: `resources/probes/fork_probe.py` (re-runnable; `--no-fixtures` to
  record without touching fixtures; `--backend pi|codex` to run one side).
- Fixtures: `resources/fixtures/pi/fork.jsonl` (a cloned Pi session with a turn
  driven inside it; header carries `parentSession`) and
  `resources/fixtures/codex/fork.jsonl` (a forked Codex thread with a turn
  driven inside it; `session_meta` carries `forked_from_id`). Both scrubbed of
  operator identifiers per `resources/fixtures/README.md`.
- Command-surface deltas recorded as HANDOFF findings 47 (`rpc.md` 32 commands
  vs. `PiCommand`'s 11) and 48 (`ClientRequest.json` 133 methods vs. the
  adapter's ~11).
