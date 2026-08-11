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

No source exists yet. This repo currently holds the design and its evidence.
