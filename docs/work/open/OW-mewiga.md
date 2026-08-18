---
kind: unverified
where: '`src/server/adapters/pi/protocol.ts` (`PiCommand`), `src/server/adapters/pi/process.ts:338-360`, `src/server/adapters/codex/adapter.ts:370-405`, `resources/probes/`'
---

# Nothing here has ever run a fork on either backend, and only one of the two forking models is even wired.

`DESIGN.md:21` makes forking a project goal and HANDOFF finding 7 backs it with
*"both backends support fork-from-past natively"*. Neither has been reproduced.
The server side is fully built against that belief — adapter contract
(`src/server/adapters/types.ts:75-76`), both implementations, routes at
`src/server/http/app.ts:247` and `:269` — and every claim about what those calls
do traces to one hand transcription of Pi's `rpc.md` and one reading of the
Codex bindings. `rpc.md` is not in this repo and not on the home server; per
`HANDOFF.md:242` it lives at
`/home/asa0717/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.
**This item is for the work laptop**, which has that file, both CLIs, and the
session corpus of finding 19 (583 Codex + 390 Pi files across 28 workspaces).

## The two models, both wanted

Decided by the owner on 2026-08-18: support **both**, within whatever each
harness allows.

- **Rewind in session** — go back a turn or two and re-ask. The common case;
  the point is to spend the turn again, not to keep what it produced.
- **Fork to a new session** — pursue several ideas in parallel from a known
  spot, without writing a handoff document to carry the context across.

Motivation is already on record in closed OW-73: a mis-sent draft *"costs a
real turn in both directions and cannot be rewound. Fork would, and Agentpane
has no fork."*

## The 2×2, and what is unknown in each cell

- **Pi, rewind.** RPC `fork` (`pi/process.ts:343`), wired. Its docblock says it
  rewinds the active branch of the *same* session file in place. Unknown:
  whether the abandoned tail survives as a reachable branch or is destroyed —
  which decides whether the operation needs a warning before it fires.
- **Pi, new session.** Presumably `clone`, whose existence is known here only
  from an aside in that same docblock (`process.ts:355`, *"rpc.md's `fork` vs
  `clone`"*). It is **not** in the transcribed `PiCommand` union
  (`pi/protocol.ts:26-44`), and neither is `get_tree`, though `DESIGN.md:520`
  lists it among Pi's commands. The owner reports Pi's CLI offers `/fork` and
  `/tree` for these two models. **Highest-value unknown in this item: does
  `clone` take an entry id, or only copy a whole session?** If whole-session
  only, branching from a chosen point into a new session on Pi is some
  composition of the two commands, or is unavailable — and that single
  parameter decides what parallel exploration can feel like on Pi.
- **Codex, new session.** `thread/fork` with `lastTurnId`
  (`codex/adapter.ts:391`), wired, and exactly this model. Unknown is OW-22's:
  it mints a thread id for a session the process table has never heard of.
- **Codex, rewind.** `thread/rollback`, which `codex/adapter.ts:370` records as
  **DEPRECATED in the generated bindings and deliberately unused**. This is the
  likeliest place a harness limit bites. Unknown: whether a supported
  replacement exists today.

## Bring back both command surfaces while you are there

`pi/protocol.ts:8` says `PiCommand` is hand-transcribed from `rpc.md`, so
anything absent was either missing upstream or dropped in transcription, and
one read settles the whole delta rather than the fork-shaped slice of it.
Closed OW-74 already flagged Pi's surface as not fully known here (thinking
level, compaction knobs, bash-as-a-command, session naming) and carries the
matching Codex incantation: `codex app-server generate-json-schema --out <dir>
--experimental`, then read `ClientRequest.json`. Do both. The trip between
machines is the expensive part, not the reading.

## Survey the corpus first — it is free, and it shapes the live run

Both stores are plain JSONL, enumerable with nothing running (findings 18, 19).
Read-only, so it costs nothing and may answer outright:

- `pi/process.ts:207` already asserts a Pi session file *"carries pre-compaction
  history and abandoned branches"*. If any corpus file has one, that settles the
  Pi-rewind cell without a live run, and shows what a branch looks like on disk.
- Codex `Thread` carries `forkedFromId` (finding 21) — but that is from
  `thread/list` over the protocol. Whether the lineage is also in the on-disk
  `session_meta` is itself worth knowing, and the corpus answers it.

## Constraints on the live half

- **Never fork a corpus session.** Pi's rewrites the file in place. Scratch
  sessions in a temp workspace only; creating them is fine (owner, 2026-08-18).
- **`ephemeral: true` does not apply here.** Finding 25 has it keeping threads
  out of `~/.codex/sessions`, which is how `capture_fixtures.py` stays clean —
  but the on-disk residue *is* the question, so it must not be used.
- **A returned id proves nothing about the new-session model.** The point of
  forking to a new session is to work in it, and OW-22 is a specific reason to
  doubt it is reachable. Attach to the returned ref and drive a real turn in it.
  Rewind, by contrast, is proven by inspection.
- Pi's `fork` veto is reported as `success: true` with `data.cancelled: true`
  (finding 30) — a probe that trusts the response alone can report a rewind that
  did not happen.

## What has to cross back

Evidence written only into a commit message is a sentence the home server has to
take on faith. Weight this toward artifacts: a probe under `resources/probes/`
beside `pi_rpc_probe.sh` and `codex_turn_probe.py`, and **captured fixtures** of
a forked or branched session per backend under `resources/fixtures/`. Those
fixtures are the only means by which fork work becomes possible on the machine
that cannot run either CLI.

Out of scope, deliberately: no UI, no client code, and this does not settle
OW-22 — it produces what OW-22 needs to be settled with the Codex adapter in
hand, which is what that item asks for.

## Done when

`MANUAL_TESTING.md` carries a live-run record for each of the four cells,
saying for each whether the operation exists, what it returned, and what it left
on disk — including the ones that turn out to be unavailable, since "Codex
cannot rewind" is a result this item is asking for and not a failure to report
it. A re-runnable probe in `resources/probes/` produces that record, and its
new-session cases end with a completed assistant turn *inside the forked
session*. At least one forked-or-branched session fixture per backend lands in
`resources/fixtures/`. The rpc.md-vs-`PiCommand` and `ClientRequest.json`-vs-
adapter deltas are recorded as HANDOFF findings. `DESIGN.md:21` and HANDOFF
finding 7 are corrected wherever *"both backends support this natively"* proves
too flat to be true — on the evidence in hand it already flattens two different
operations, and the correction is part of this item rather than a later one.
