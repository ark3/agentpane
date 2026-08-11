# agentpane

A clean, modern web UI for coding agents — chat rendering, streaming tool
calls, session management, and fork-from-any-past-point — with a
**pluggable backend** so it can drive either **Pi** (`pi --mode rpc`) or
**Codex** (`codex app-server`), each sandboxed per workspace.

Spiritually: [pipane](https://github.com/mike-heunher/pipane), but on the
current maintained UI library and multi-backend.

## Start here

1. **`docs/HANDOFF.md`** — read first. What is already validated (with
   re-runnable evidence), reference material by absolute path, and the
   workflow for the fresh agent picking this up.
2. **`docs/DESIGN.md`** — the design: goals/non-goals, architecture, the
   backend adapter contract, the Codex→`AgentMessage` mapping, and the test
   strategy.
3. **`resources/`** — validated Codex protocol bindings and reproducible
   probe scripts.

No source exists yet. This repo currently holds the design and its evidence.
