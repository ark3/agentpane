# Probes — reproducible validation evidence

These scripts are the *executable proof* behind the claims in
`docs/HANDOFF.md`. They were run during design validation and can be re-run
any time to re-confirm the agent protocols on the current CLI versions.

## `pi_rpc_probe.sh`

Proves: **Pi's `--mode rpc` emits `AgentMessage`-shaped objects** — the exact
type `pi-web-ui`'s `MessageList` consumes. Run it and inspect the
`message_end` payload; it has `role`, `content` blocks, `usage`, `stopReason`,
`model`, `timestamp`.

```bash
bash pi_rpc_probe.sh
```

Verified with: `pi` 0.84.1.

## `codex_turn_probe.py`

Proves: **`codex app-server` runs a full turn over stdio** —
`initialize` → `thread/start` → `turn/start` → streaming
`item/agentMessage/delta` → `item/completed` → `turn/completed`.

```bash
python3 codex_turn_probe.py
```

Note: Codex needs a *writable* `CODEX_HOME` with valid auth. The script copies
your real `~/.codex/{auth.json,config.toml}` into a temp home because the
sandbox makes `~/.codex` read-only. It cleans up the temp copy on exit.

It also proves (OW-tifuha) that **`turn/steer` works against a live turn**: fired mid-stream with `expectedTurnId` set to the active turn, it returns that same turn id and its text is answered inside that turn, opening no second turn.
Extend the wait or the prompt if a faster model finishes before the steer lands.

Verified with: `codex-cli` 0.147.0; the steer phase with `codex-cli` 0.154.0 on 2026-09-12.

## `agentpane_codex_smoke.py`

Proves the assembled application path with a real Codex process: build and
serve the production client, create/attach through REST, observe incremental
SSE transcript updates and idle completion, reconnect and verify a repaint
without another native worker, abort a long turn, then shut the server down and
verify the run-scoped worker exited.

```bash
python3 agentpane_codex_smoke.py \
  --workspace /home/asa0717/src/agentpane
```

This makes live model calls. It derives the application checkout from its own
location, creates and removes a temporary writable `CODEX_HOME`, copies only
`auth.json`/`config.toml` without printing them, and inspects only descendants
of the server it starts. It never invokes Pi. Exit 0 plus the emitted JSON
`"result": "pass"` is the acceptance signal.

## `agentpane_pi_smoke.py`

The same assembled application path with a real Pi process, plus the three things only Pi can establish: that the production `direnv exec <workspace> sbox -- pi --mode rpc` chain actually starts an agent (`capture_fixtures.py` deliberately bypasses sbox, so nothing had run this chain until this harness first did), that the session id changes under the client and the superseded id keeps working, and that killing the server reaches an agent two `exec`s down inside `bwrap`.

```bash
python3 agentpane_pi_smoke.py --workspace /home/asa0717/src/agentpane
python3 agentpane_pi_smoke.py --workspace ... --tool-check   # also assert a toolCall block
```

Same guarantees as the Codex harness: temporary writable state dir
(`PI_CODING_AGENT_DIR`), credentials copied by name and never printed,
inspection scoped to this run's server tree. It never invokes Codex.

`--tool-check` is opt-in because it is the most model-dependent criterion --
the model has to choose to call a tool. It passes; it is separated so the
default run stays deterministic.

Verified with: `pi` 0.85.1 on the home server, 2026-09-13, both bare and with `--tool-check`; those were its first runs on that machine.
See `docs/MANUAL_TESTING.md`, "The Pi smoke probe runs on the home server, end to end through the built server" (OW-moradi), for what the evidence said and the three defects it exposed (OW-guvojo, OW-hahohi, OW-lapuye).

## `agentpane_pi_steer_probe.py`

Proves: **which of D16's three outcomes Pi's mid-turn 202 actually is** (OW-yuyofu).
Copied from `agentpane_pi_smoke.py` rather than added to it — the card asked for a separate vehicle — and shaped after `codex_turn_probe.py`'s steer phase: start a turn that keeps streaming, confirm it is streaming at the instant of the request, post a second prompt carrying a unique marker through the ordinary REST submit route, then read off Pi's own events whether the marker was answered inside the running turn, in a following turn, or never.

```bash
python3 agentpane_pi_steer_probe.py
python3 agentpane_pi_steer_probe.py --skip-build      # reuse dist/client
python3 agentpane_pi_steer_probe.py --model <ref>     # default is the model AGENTS.md pins
```

Two things it does that the other live harnesses do not.

It **taps Pi's stdout**, because none of the discriminating evidence reaches agentpane's SSE wire: `src/server/adapters/pi/reducer.ts` drops `turn_start`, `turn_end`, `agent_end` and `queue_update` as session bookkeeping, and `agent_settled` alone cannot tell a steer from a drained follow-up queue.
The tap is a `pi` shim first on the server's PATH that pipes the real binary through `tee`; it is transparent to the adapter, and it adds an `sh` and a `tee` to the sandbox tree, which the probe's worker filter reaps along with the agent.
The tap preserves order, not time — `tee` stamps nothing — so every duration in the record is measured from a stamp taken immediately before the request that caused the event, and positions in the tap are pinned by reading its line count at the instant the mid-turn POST goes out.

It **passes `--model` explicitly**, unlike `agentpane_pi_smoke.py`, through the create-session route's `model` field.
The first turn's length is a criterion here, so a run that silently answered on whatever `~/.pi/agent/settings.json` happened to name would not be measuring what it reports; the model that answered is still read back off the wire and recorded.

Writes no fixtures.
Same temporary writable state dir and credentials-copied-by-name discipline as the two smoke harnesses.
Costs tokens: one long turn plus the steered reply.

Verified with: `pi` 0.85.1 on the home server, 2026-09-14.
What it showed is `docs/MANUAL_TESTING.md`, "A prompt posted mid-turn is steered into Pi's running turn (OW-yuyofu)".

## `agentpane_live_support.py`

Not a probe. The machinery both smoke checks share: the HTTP/SSE client, the
process-tree walk, the temporary state dir, and the cleanup criteria. It exists
because the two harnesses differ only in which backend they drive.

## `capture_fixtures.py`

The other two scripts *prove* the protocols work; this one **records** them.
It runs a set of scenarios against each backend and writes every emitted line
to `../fixtures/<backend>/<scenario>.jsonl`, plus a `.meta.json` with
provenance and an event census. Identifying values (model ids, provider names,
hostnames, user agent) are scrubbed to placeholders on the way out, because
fixtures get committed — see `SCRUB_KEYS` in the script. That scrub is keyed on
JSON field names, so it cannot catch operator data a backend echoes into
free-form *content* (a fork capture leaked the home path and skills manifest
this way — see `../fixtures/README.md`, "Scrubbed values"). Any new capturing
probe must grep its generated fixture for operator identifiers before the
fixture is committed; `src/fixture-scrub.test.ts` fails `bun run check` on a
home path, but the username and hostname are still yours to check.

```bash
python3 capture_fixtures.py                                # all
python3 capture_fixtures.py --backend codex --scenario tool-edit
```

Read `../fixtures/README.md` for what was captured and what it revealed.

## `fork_probe.py`

Proves: **the 2×2 of `{Pi, Codex} × {rewind, new session}`** — the fork claim
in `DESIGN.md:21` and HANDOFF finding 7, which nothing had ever run (OW-mewiga)
— plus a fifth cell that forks Codex *mid-stream* (OW-gojado). Runs all five
cells live and prints a JSON record saying, for each, whether the operation
exists, what it returned, and what it left on disk:

- **Pi rewind** (`fork`): copy-on-write on 0.84.2 — original file untouched, the
  re-ask spins off a new `parentSession`-linked file, so the abandoned tail
  survives (HANDOFF 43).
- **Pi new session** (`clone` + `switch_session`): `clone` takes no entry id;
  it copies the whole active branch to a new file and the process is switched
  into it to drive a real turn (HANDOFF 44).
- **Codex new session** (`thread/fork` + `lastTurnId`): new thread id, on-disk
  `forked_from_id`, a real turn driven in the fork (HANDOFF 45).
- **Codex rewind** (`thread/rollback`): recorded as DEPRECATED from the live
  schema rather than fired — "Codex cannot rewind" is the result (HANDOFF 46).
- **Codex mid-stream** (`thread/fork` into a running parent): the only cell that
  reports the *parent* rather than the fork, and the one D15 asked for
  (OW-gojado).
  It confirms the parent is streaming before forking — `turn/started` seen plus `item/agentMessage/delta`s accumulating, never a sleep — and re-reads the buffer once more at the instant the fork request goes out, since the turn can settle in the gap after the threshold is met; it records `result: "unearned"` and exits non-zero if either check fails, because a fork fired at a turn that had already settled measures nothing and fails silently.
  The same gate covers the disk read (OW-wifibe): a parent rollout the cell could not resolve, one that was not on disk to begin with, or one whose already-written lines moved under it all make it "unearned" too, because the finding is what that file gained and a file that was never found gains nothing in the identical way.
  On 0.154.0 the parent survives: deltas keep arriving after the fork, `turn/completed` carries `status: "completed"`, and the whole reply lands in the parent rollout, which the cell sha256s at the fork and again after and then *reads* — the header-only `parent_untouched` check the new-session cell makes could not have told those outcomes apart.
  It also validates the fork itself past the returned id — `thread/read` on it, and its rollout on disk with `forked_from_id` — but drives no turn in it, because the parent is the subject.
  Writes no fixture: nothing here is a protocol shape worth committing, and the cell's own JSON record carries the census of every rollout line the parent gained, which is what a later reader needs.

```bash
python3 fork_probe.py                 # all five cells, write fixtures
python3 fork_probe.py --no-fixtures   # record only
python3 fork_probe.py --backend pi    # one side
```

Writes `../fixtures/{pi,codex}/fork.jsonl` (a forked/cloned session per backend,
with a turn driven inside it). Same writable-state-dir and never-fork-a-corpus-
session discipline as `capture_fixtures.py`; Codex threads are deliberately NOT
ephemeral here because the on-disk residue is the question. New-session cells
end with a completed assistant turn inside the fork, so a returned id alone
cannot pass the check.
Exit non-zero if either new-session cell failed to drive a turn, or if the mid-stream cell's own `result` is anything but `measured`.

Verified with: `pi` 0.84.2, `codex-cli` 0.147.0; the mid-stream cell with
`codex-cli` 0.154.0, on which the rollout no longer writes an
`event_msg`/`agent_message` beside each assistant `response_item` — so
`fork.jsonl`, captured on 0.147.0, is a version behind on line shapes. What that cell showed is `docs/MANUAL_TESTING.md`,
"Forking a Codex thread mid-stream leaves the parent turn running (OW-gojado)".

Two things it handles that the older probes do not, and that will bite anyone
writing their own harness:

- **Writable state dirs.** Both agents need one (`PI_CODING_AGENT_DIR`,
  `CODEX_HOME`), and running under `sbox` does not provide it inside an
  already-sandboxed session. Without it a turn "succeeds" in under a second
  with `stopReason: "error"` and empty content.
- **Blocking requests.** Pi's `extension_ui_request` dialogs and Codex's
  `ServerRequest` approvals both wait for an answer. The harness answers them
  and records that they happened.

## `approval_policy_probe.py`

Proves: **what `approvalPolicy` does to Codex's approval `ServerRequest`s, and
what a forked thread carries** (OW-18). Eight live cells against `codex
app-server`:
the same edit-provoking prompt on `danger-full-access` and on `read-only`, each
with and without `approvalPolicy: "never"`; two `thread/fork` cells that read
`sandbox` and `approvalPolicy` straight off `ThreadForkResponse`; and two that
try to provoke an `item/tool/requestUserInput`.

```bash
python3 approval_policy_probe.py            # all cells, JSON record on stdout
python3 approval_policy_probe.py --timeout 150
```

The `read-only` pair is the control that makes the read-only `never` cell mean
something: without it, "no approval arrived" cannot be told apart from "the
prompt never provoked one". It licenses nothing about the `danger-full-access`
pair, where no approval arose either way.

Each server-initiated request is recorded **with its method and params**,
before being answered, in a list of its own -- so a cell reports which requests
arrived, not merely that some did. `fork_probe.py` also logs each one before
answering, but it answers every server request uniformly and keeps no separate
record.

Writes no fixtures. One temporary writable `CODEX_HOME` for the whole run, with
`auth.json`/`config.toml` copied in by name and never printed -- only the
config's key and table *names* reach the record, so a reader can tell
app-server's defaults from the operator's config. A temporary git workspace per
cell. Both removed on exit. Threads are ephemeral except the fork parents,
which have to materialise on disk for `thread/fork` to load them. Costs tokens:
every cell drives a real model turn.

Verified with: `codex-cli` 0.154.0. What it showed is `docs/MANUAL_TESTING.md`,
"Observed Codex approval policy, and what a fork carries (OW-18)".

## `claude_fork_probe.py`

Proves: **what a mid-stream fork costs a Claude Code parent turn** (OW-japuzo).
Written when `docs/DESIGN.md` D15 was headed "on every backend" and reasoned about Pi and Codex only, so this was the third backend being asked its question; D15 has since been rewritten on what this probe found.
Two cells, both reading the PARENT and never the fork.

```bash
python3 claude_fork_probe.py             # both cells, JSON record on stdout
python3 claude_fork_probe.py --cell kill # one of them
```

`--cell kill` reproduces the kill `claude/adapter.ts` `fork()` performed before OW-razoki deleted `replaceProcess` on 2026-09-13 — `replaceProcess` then `ChildClaudeProcess.kill()`, SIGTERM and a grace and SIGKILL — and asks whether the streaming partial had reached `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` before it landed.
`--cell fork` spawns the fork as a **second** child instead of replacing the first and asks whether the parent turn survives, reading the parent's store both the instant its `result` is seen and again once the writer has quiesced.
That second cell is a probe and not a proposal: it changes nothing in `adapter.ts`, because the point is to establish the behaviour before anyone decides whether the adapter should work that way.

Separate from `fork_probe.py` rather than a third `--backend` in it: that probe's cells are JSON-RPC clients where a fork is one request on a live server, and Claude Code has no RPC surface for a fork at all — it is a process spawn carrying `--fork-session`, over an unmatched NDJSON stream with no request ids.

The streaming discipline comes from `fork_probe.py`'s `codex_fork_mid_stream` cell: `message_start` plus accumulating text deltas before the action, and `result: "unearned"` with a non-zero exit when they are missing.
Two parts were **additions rather than inheritance** when this probe was written, and both have since been carried back into that cell (OW-wifibe).
`still_streaming` re-reads the buffer at the instant of the action, because the threshold being met is not the turn still running when the action lands.
And the "unearned" gate covers the disk read, not just the wire: an unresolved store file, a baseline that does not exist, or a store whose existing lines changed under the cell all fail it.
That last one matters because the headline finding is an *absence* on disk, and a file that was never found produces the identical absence.

The delta threshold is forty rather than the Codex cell's five, and the `kill` cell samples the store at four marks across the reply rather than one.
Both come from runs that went wrong.
A low threshold cannot tell the answer streaming from the coda after it: asked for the integers 1 through 400, haiku called `Bash` and then streamed a short "the counting is complete" summary, so the action landed after the turn had finished and nothing said so.
And one mid-turn sample cannot tell "the store never gains assistant text mid-turn" from "it had not gained any at the one point we looked".

`--tools ""` is there to remove the tool shortcut, and production does not pass it.
What the flag does was checked directly on 2.1.268: with it, `system:init` advertises no built-in tools and the model answers that it has no `Bash` tool available.
It does **not** remove MCP tools, which `init.tools` still lists, so this probe's records are sensitive to the operator's MCP configuration and the cells report their gained-line census by kind partly so a stray `tool_use` would be visible.

The probe spawns `claude` directly rather than through `direnv exec <cwd> sbox`, which is not available on the home server.
It passes by hand the `--permission-mode bypassPermissions` that sbox injects, as 10 of the 11 captures under `resources/fixtures/claude/` do.

Writes no fixtures.
A throwaway git workspace per cell under the temp area, removed on exit, which keeps the probe's sessions in their own `~/.claude/projects/` directory rather than this repo's.
The store files themselves are left where the CLI put them.
Costs tokens: each cell drives two real model turns, one of them long.

Verified with: `claude` 2.1.268 on explicit `--model haiku`.
What it showed is `docs/MANUAL_TESTING.md`, "A mid-stream fork on Claude Code loses the partial reply, but only because agentpane kills the process (OW-japuzo)".

## Why these live here

A fresh agent building this project has none of the validation conversation's
context. Re-running these is the fastest way to re-establish ground truth
before trusting the `AgentMessage` mapping in `docs/DESIGN.md`.
