# Probes — reproducible validation evidence

These two scripts are the *executable proof* behind the claims in
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
