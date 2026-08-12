# agentpane

A clean, modern web UI for coding agents — chat rendering, streaming tool
calls, session management, and fork-from-any-past-point — with a
**pluggable backend** so it can drive either **Pi** (`pi --mode rpc`) or
**Codex** (`codex app-server`), each sandboxed per workspace.

Spiritually: [pipane](https://github.com/mike-heunher/pipane) — same
architecture (sandboxed subprocess per session, browser as a repaintable
view), but multi-backend and with its own client stack.

## Start here

1. **`docs/HANDOFF.md`** — read first. What is already validated (with
   re-runnable evidence), reference material by absolute path, and the
   workflow for the fresh agent picking this up.
2. **`docs/DESIGN.md`** — the design: goals/non-goals, architecture, the
   settled decisions and their reasoning, the backend adapter contract, the
   Codex→`AgentMessage` mapping, and the test strategy.
3. **`resources/`** — validated Codex protocol bindings, reproducible probe
   scripts, and captured protocol fixtures for offline adapter tests.

## Development

Install dependencies once:

```bash
bun install
```

For local development, run the API server and Vite client in separate
terminals. Vite proxies `/api` to the server on `127.0.0.1:4173`.

```bash
bun run dev
```

```bash
bun run dev:client
```

For a production-style local run, build the client and let the Bun server
serve both the static application and API:

```bash
bun run build
bun run start
```

Run the complete offline verification suite with:

```bash
bun run check
```

Live runs against both real backends are recorded in
[`docs/MANUAL_TESTING.md`](docs/MANUAL_TESTING.md) and re-runnable from
`resources/probes/agentpane_{codex,pi}_smoke.py`. They exercise the built
client's reachability and the REST/SSE path with a real agent subprocess:
create/attach, streaming, idle, reconnect, abort, and shutdown without an
orphan.

**For what is done and what is left, read
[`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md)** — its Status table is the only
statement of project status, and its Open work list is the only list of
outstanding items. Both are deliberately not repeated here.
