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

## Why these live here

A fresh agent building this project has none of the validation conversation's
context. Re-running these is the fastest way to re-establish ground truth
before trusting the `AgentMessage` mapping in `docs/DESIGN.md`.
