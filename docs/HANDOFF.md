# Handoff

You are picking up **agentpane** with none of the design conversation's
context. This document gives you ground truth: what is already proven, where
the reference material lives, and how to re-verify anything before you trust
it. Read this, then `docs/DESIGN.md`.

The one rule that produced this design: **verify at the source, don't reason
from memory.** Every claim below was checked against a running CLI or an
extracted type — not recalled. Hold yourself to the same bar.

## What agentpane is

A local web UI for coding agents. One server process owns one sandboxed agent
subprocess per session, bridges its event stream to a browser over WebSocket,
and renders it with the maintained `pi-web-ui` component library. It must
drive **two** backends behind one adapter contract: **Pi** and **Codex**.

This is "pipane, upgraded": pipane already proved the shape (subprocess +
WebSocket + `pi-web-ui`), but it is Pi-only and pinned to a frozen old package
scope. agentpane targets the current `@earendil-works/*` scope and adds a
Codex backend.

## Validated facts (with evidence)

Every load-bearing assumption was reproduced live. Re-run the probes in
`resources/probes/` to re-confirm.

| # | Claim | How it was verified |
|---|-------|---------------------|
| 1 | `pi-web-ui@0.75.3` is maintained and exports the renderers (`MessageList`, `ChatPanel`, `registerMessageRenderer`, `registerToolRenderer`) | `npm view @earendil-works/pi-web-ui`; extracted `dist/*.d.ts` from the tarball |
| 2 | The UI renders **`AgentMessage[]`** (from `@earendil-works/pi-agent-core`), not raw protocol events | `MessageList.d.ts`: `messages: AgentMessage[]` |
| 3 | Pi's `--mode rpc` `message_end` events **already are `AgentMessage` objects** (role, content blocks, usage, stopReason, model, timestamp) | `resources/probes/pi_rpc_probe.sh`, live turn on pi 0.84.1 |
| 4 | `codex app-server` speaks a real protocol over **stdio** (`stdio://` is the default `--listen`), so it is sbox-transparent like Pi | `codex app-server --help`; `resources/probes/codex_turn_probe.py` |
| 5 | Codex ships its **entire protocol as generated TypeScript + JSON Schema** (`codex app-server generate-ts` / `generate-json-schema`) | Generated bindings copied to `resources/codex-protocol/` (93 files) |
| 6 | A full Codex turn works: `initialize` → `thread/start` → `turn/start` → streaming `item/agentMessage/delta` → `item/completed` → `turn/completed` | `resources/probes/codex_turn_probe.py`, live turn on codex-cli 0.147.0 |
| 7 | **Both** backends support fork-from-past natively: Pi `fork`/`get_fork_messages`; Codex `thread/fork` + `thread/rollback` | Pi `docs/rpc.md`; Codex `resources/codex-protocol/ClientRequest.ts` |
| 8 | The sandbox seam works transparently over stdio | Proven in production: pipane ran `sandboxed-pi` (`~/.local/bin/sandboxed-pi` → `sbox -- pi`) |

**No showstopper was found.** The single real engineering task is the Codex
`ThreadItem` → `AgentMessage` mapping (see `docs/DESIGN.md`); everything else
is assembly of proven pieces.

## Environment gotchas (learned the hard way)

- **Sandbox.** This machine runs inside a bubblewrap sandbox (`~/bin/sbox`);
  most of the filesystem is read-only. `~/src/agentpane` was granted write
  access specifically for this work. If you can write elsewhere in `$HOME`,
  the sandbox is off — warn the user.
- **Codex needs a writable `CODEX_HOME`.** It initializes a sqlite state
  runtime there. Under the sandbox `~/.codex` is read-only, so the Codex probe
  points `CODEX_HOME` at a temp dir and copies `auth.json` + `config.toml` in.
  The real agentpane, spawning Codex through sbox with the `codex` profile,
  gets `~/.codex` mounted read-write and avoids this.
- **Pi RPC framing is LF-only.** Split on `\n` only; do not use Node
  `readline` (it also splits on U+2028/U+2029, which are valid inside JSON
  strings). See Pi's `docs/rpc.md` "Framing".

## Reference material (absolute paths — read these directly)

- **pipane** (the architecture to emulate; Pi-only, old scope):
  `/home/asa0717/src/pipane`
  - `src/server/pi-launch.ts` — the executable-resolution seam (this is where
    sbox slots in)
  - `src/server/process-pool.ts`, `attached-session.ts` — subprocess
    lifecycle / session-to-process binding
  - `src/server/ws-handler.ts`, `src/client/ws-agent-adapter.ts` — the
    WebSocket bridge, both ends
  - `src/shared/jsonl-sync.ts` — transcript sync / reconnect coherence
  - `src/client/fork-modal.ts`, `session-picker.ts` — fork UI, session list
  - `src/client/{message,tool}-renderers.ts` — custom renderers layered on
    `pi-web-ui`
  - Note `patches/@mariozechner+pi-web-ui+0.55.3.patch` — pipane monkey-patched
    the old lib; the API has drifted ~20 minor versions, so **borrow patterns,
    not files verbatim.**
- **sbox** (the sandbox): `/home/asa0717/src/sandbox/sbox`. Has `pi` and
  `codex` profiles already (mounts `~/.pi/agent` / `~/.codex` rw), auto-detects
  the workspace (git root / marker), injects `codex --sandbox
  danger-full-access` so Codex doesn't run its own sandbox. Uses `--ro-bind /
  /` + `--share-net` (so Codex loopback works, but there is no network
  isolation and full-home read exposure — a known gap, not this project's
  problem).
- **`sandboxed-pi`**: `/home/asa0717/.local/bin/sandboxed-pi` —
  `exec direnv exec "$(pwd)" sbox -- pi "$@"`. The direnv step loads
  per-workspace env (API keys/model config) before entering the jail; preserve
  that pattern per session.
- **omnigent** (reference only, do not depend on it):
  `/home/asa0717/src/omnigent`. It solves a much larger multi-agent/enterprise
  problem; its Codex integration (`omnigent/codex_native_app_server.py`) is a
  worked example of driving `app-server`, but you now have the official
  generated bindings, so prefer those.
- **Pi packages** (current scope, on disk):
  `/home/asa0717/.bun/install/global/node_modules/@earendil-works/`
  - `pi-coding-agent/docs/rpc.md` — the full Pi RPC protocol (authoritative)
  - `pi-coding-agent/docs/sdk.md` — the in-process SDK (NOT used here; we spawn
    subprocesses for sandboxing — see DESIGN non-goals)
  - `pi-agent-core/dist/types.d.ts` — `AgentMessage`
  - `pi-ai/dist/types.d.ts` — `UserMessage`/`AssistantMessage`/
    `ToolResultMessage` and the content blocks (`text`, `thinking`, `toolCall`,
    `image`)
  - `pi-web-ui/dist/**` — the UI components (`MessageList.d.ts` is the render
    contract)

## Workflow for building

1. Re-run both probes in `resources/probes/` to confirm the CLIs still behave
   as recorded (versions drift).
2. Read `docs/DESIGN.md`, especially the adapter contract and the Codex
   mapping table.
3. Scaffold `src/` (pipane's `client`/`server`/`shared` split is a good model)
   and adopt the test strategy in DESIGN before writing features.
4. Keep `resources/codex-protocol/` as the source of truth for Codex types —
   decide whether to import them into `src/` or reference them; do not
   hand-write Codex types.

Once the build starts, this HANDOFF can be archived; `docs/DESIGN.md` is the
durable document.
