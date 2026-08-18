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

Verified with: `codex-cli` 0.147.0.

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

The same assembled application path with a real Pi process, plus the three
things only Pi can establish: that the production `direnv exec <workspace>
sbox -- pi --mode rpc` chain actually starts an agent (`capture_fixtures.py`
deliberately bypasses sbox, so nothing had ever run this), that the session id
changes under the client and the superseded id keeps working, and that killing
the server reaches an agent two `exec`s down inside `bwrap`.

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
fixtures get committed — see `SCRUB_KEYS` in the script.

```bash
python3 capture_fixtures.py                                # all
python3 capture_fixtures.py --backend codex --scenario tool-edit
```

Read `../fixtures/README.md` for what was captured and what it revealed.

## `fork_probe.py`

Proves: **the 2×2 of `{Pi, Codex} × {rewind, new session}`** — the fork claim
in `DESIGN.md:21` and HANDOFF finding 7, which nothing had ever run (OW-mewiga).
Runs all four cells live and prints a JSON record saying, for each, whether the
operation exists, what it returned, and what it left on disk:

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

```bash
python3 fork_probe.py                 # all four cells, write fixtures
python3 fork_probe.py --no-fixtures   # record only
python3 fork_probe.py --backend pi    # one side
```

Writes `../fixtures/{pi,codex}/fork.jsonl` (a forked/cloned session per backend,
with a turn driven inside it). Same writable-state-dir and never-fork-a-corpus-
session discipline as `capture_fixtures.py`; Codex threads are deliberately NOT
ephemeral here because the on-disk residue is the question. New-session cells
end with a completed assistant turn inside the fork, so a returned id alone
cannot pass the check. Exit non-zero if either new-session cell failed to drive
a turn.

Verified with: `pi` 0.84.2, `codex-cli` 0.147.0.

Two things it handles that the older probes do not, and that will bite anyone
writing their own harness:

- **Writable state dirs.** Both agents need one (`PI_CODING_AGENT_DIR`,
  `CODEX_HOME`), and running under `sbox` does not provide it inside an
  already-sandboxed session. Without it a turn "succeeds" in under a second
  with `stopReason: "error"` and empty content.
- **Blocking requests.** Pi's `extension_ui_request` dialogs and Codex's
  `ServerRequest` approvals both wait for an answer. The harness answers them
  and records that they happened.

## Why these live here

A fresh agent building this project has none of the validation conversation's
context. Re-running these is the fastest way to re-establish ground truth
before trusting the `AgentMessage` mapping in `docs/DESIGN.md`.
