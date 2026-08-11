# Handoff

You are picking up **agentpane** with none of the design conversation's
context. This document gives you ground truth: what is already proven, where
the reference material lives, and how to re-verify anything before you trust
it.

**The build has started.** This document is now the evidence base rather than
the starting point — read `docs/DESIGN.md` for the decisions and
`docs/WORKSTREAMS.md` for what is built, what is left, and what to pick up
next. Two sections here stay live regardless: **Environment gotchas**, which
will cost you an afternoon if you skip it, and **Reference material**, which is
where the authoritative protocol docs live. The findings tables are the record
of how each decision was established; consult them when a premise looks wrong.

The one rule that produced this design: **verify at the source, don't reason
from memory.** Every claim below was checked against a running CLI or an
extracted type — not recalled. Hold yourself to the same bar. The most
expensive defect found during the build was an unexamined assumption about
which events `node:child_process` emits when a spawn fails.

## What agentpane is

A local web UI for coding agents. One server process owns one sandboxed agent
subprocess per session, owns the transcript, and streams it to a browser over
SSE. It must drive **two** backends behind one adapter contract: **Pi** and
**Codex**.

pipane proved the architecture (sandboxed subprocess + a browser view that
can drop and repaint), and agentpane keeps those patterns. It does **not**
keep pipane's client stack: the original plan to build on `pi-web-ui` was
reversed after investigation — see "Superseded conclusions" below and D5 in
`docs/DESIGN.md`.

## Validated facts (with evidence)

Every load-bearing assumption was reproduced live. Re-run the probes in
`resources/probes/` to re-confirm.

| # | Claim | How it was verified |
|---|-------|---------------------|
| 1 | `pi-web-ui@0.75.3` is maintained and exports the renderers (`MessageList`, `ChatPanel`, `registerMessageRenderer`, `registerToolRenderer`) | `npm view @earendil-works/pi-web-ui`; extracted `dist/*.d.ts` from the tarball |
| 2 | The UI renders **`AgentMessage[]`** (from `@earendil-works/pi-agent-core`), not raw protocol events | `MessageList.d.ts`: `messages: AgentMessage[]` |
| 3 | Pi's `--mode rpc` `message_end` events **already are `AgentMessage` objects** (role, content blocks, usage, stopReason, model, timestamp) | `resources/probes/pi_rpc_probe.sh`, live turn on pi 0.84.1 |
| 4 | `codex app-server` speaks a real protocol over **stdio** (`stdio://` is the default `--listen`), so it is sbox-transparent like Pi | `codex app-server --help`; `resources/probes/codex_turn_probe.py` |
| 5 | Codex ships its **entire protocol as generated TypeScript + JSON Schema** (`codex app-server generate-ts` / `generate-json-schema`) | Generated bindings copied to `resources/codex-protocol/` (642 files, 550 of them under `v2/`) |
| 6 | A full Codex turn works: `initialize` → `thread/start` → `turn/start` → streaming `item/agentMessage/delta` → `item/completed` → `turn/completed` | `resources/probes/codex_turn_probe.py`, live turn on codex-cli 0.147.0 |
| 7 | **Both** backends support fork-from-past natively: Pi `fork`/`get_fork_messages`; Codex `thread/fork` + `thread/rollback` | Pi `docs/rpc.md`; Codex `resources/codex-protocol/ClientRequest.ts` |
| 8 | The sandbox seam works transparently over stdio | Proven in production: pipane ran `sandboxed-pi` (`~/.local/bin/sandboxed-pi` → `sbox -- pi`) |

**No showstopper was found.** The single real engineering task is still the
Codex `ThreadItem` → `AgentMessage` mapping (see `docs/DESIGN.md`).

## Second round: one reversal, and further findings

Facts 1 and 2 above are true as stated, but the *conclusion* originally drawn
from them — build the client on `pi-web-ui` — was **reversed**; findings 9–15
are why. Findings 16–25 are new ground covered while settling the transport
and session model and while capturing protocol fixtures. Everything here is
reproducible from the 0.75.3 tarball (`npm pack @earendil-works/pi-web-ui@0.75.3`),
the installed packages, the session directories named in 18, and
`resources/probes/capture_fixtures.py`.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 9 | `Agent` (in `pi-agent-core`) is a **concrete class** that runs the LLM loop in-process — it owns `streamFn`, `getApiKey`, tool execution. `ChatPanel.setAgent()` and `AgentInterface.session` both want one, which is structurally incompatible with running the model in a sandboxed subprocess | `pi-agent-core/dist/agent.d.ts`; `pi-web-ui/dist/ChatPanel.d.ts` |
| 10 | `pi-web-ui` ships **four** tool renderers — Bash, Calculate, GetCurrentTime, Default. **None** for coding tools. pipane wrote 663 lines of its own (`bash`, `read`, `edit`, `write`, `canvas`) | `ls dist/tools/renderers/`; `pipane/src/client/tool-renderers.ts` |
| 11 | `renderMessage` transitively drags `pdfjs-dist`, `xlsx`, `docx-preview`, `jszip` via a side-effect import chain (`Messages.js` → `tools/index.js` → `extract-document.js` → `attachment-utils.js`, all static top-level imports). Neither package declares `sideEffects: false`, so it cannot be tree-shaken. `xlsx` resolves from `https://cdn.sheetjs.com/...tgz`, not the registry | import chain read in `dist/`; `jq .sideEffects package.json` on both |
| 12 | No fallback tool renderer exists. pipane's patch **added** `setFallbackToolRenderer`; 0.75.3 still lacks it. Codex's `mcpToolCall`/`dynamicToolCall` carry arbitrary names that cannot be pre-registered, so one is required | `grep setFallbackToolRenderer` over the patch and over 0.75.3 `dist/` |
| 13 | mini-lit's `MarkdownBlock` escapes HTML with regexes over the markdown *source* (`escapeHtml` defaults true), then renders via `unsafeHTML` with no sanitizer on the output | `mini-lit@0.2.1 dist/MarkdownBlock.js:14-58,241` |
| 14 | Of pipane's 181-hunk `pi-web-ui` patch, ~95% is a mechanical class-fields → constructor-assignment downlevel that **0.75.3 already ships**; `createStreamFn` was absorbed upstream. Only `allowSendDuringStreaming` and `setFallbackToolRenderer` remain unfixed | patch vs. `dist/components/AgentInterface.js` in 0.75.3 |
| 15 | mini-lit is still `@mariozechner/mini-lit@0.2.1` (personal scope; the pi packages moved to `@earendil-works/*`), last published 2025-11-12 | `npm view @mariozechner/mini-lit time` |
| 16 | Codex sends **server-initiated requests** with a `RequestId` — approvals, `item/tool/requestUserInput`, MCP elicitation, dynamic tool call — and blocks until answered | `resources/codex-protocol/ServerRequest.ts` |
| 17 | pipane binds **all interfaces** (`server.listen(PORT)` with no host), gates remote access with a token, and bypasses auth for loopback. There is **no `Origin` validation** anywhere in its server | `pipane/src/server/server.ts:98,389`; `grep -ri origin src/server/` |
| 18 | **Both** backends store sessions as JSONL on disk and are enumerable with **no process running**. Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, first line `{"type":"session_meta","payload":{id,cwd,timestamp,model_provider,…}}`. Pi: `~/.pi/agent/sessions/**/*.jsonl`, first line `{"type":"session",…,cwd}` | walked and parsed directly; see D9 |
| 19 | Enumeration is **fast**: 583 Codex + 390 Pi files across 28 workspaces — walk ~0.01s, read first line of all 973 files ~0.27s (Python). No index cache is warranted yet | measured on this machine, 2026-08-10 |
| 20 | Codex header format has **drifted**: 5 of 583 files use an older bare `{id,timestamp}` header with no `cwd`. The walk must tolerate unrecognised headers rather than throw | same census |
| 21 | Codex also exposes `thread/list` over the protocol (cursor pagination, sort, `cwd`/`archived`/`searchTerm` filters), returning `Thread` with `id`, `sessionId`, `forkedFromId`, `preview`, `name`, `cwd`, `createdAt`, `updatedAt`, `status`. Not needed for enumeration (18), but richer for an attached session | `resources/codex-protocol/v2/{ThreadListParams,ThreadListResponse,Thread}.ts` |
| 22 | Codex **does** send approval requests: a live `item/fileChange/requestApproval` (followed by `serverRequest/resolved`) appears in a captured turn. Leaving one unanswered hangs the turn | `resources/fixtures/codex/tool-edit.jsonl` |
| 23 | Codex emits substantially more than the DESIGN mapping table lists — `turn/diff/updated`, `thread/tokenUsage/updated`, `thread/status/changed`, `thread/started`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed` | event census in `resources/fixtures/codex/*.meta.json` |
| 24 | Pi chose the **`bash`** tool to edit a file, not a dedicated edit tool; its assistant messages carry `text`, `thinking`, and `toolCall` blocks, with `stopReason` of `stop` and `toolUse` | `resources/fixtures/pi/*.jsonl` |
| 25 | `thread/start` accepts **`ephemeral: true`**, which keeps a thread out of the on-disk rollout store — how the fixture capture avoids polluting `~/.codex/sessions` | `resources/codex-protocol/v2/ThreadStartParams.ts`; used in `capture_fixtures.py` |
| 26 | Codex's session layout is **not uniformly `YYYY/MM/DD/`** — 3 files sit flat at `~/.codex/sessions/`, 580 are nested. Walk to arbitrary depth | census over the real directory |
| 27 | A Codex session's **first user-role block is almost never the human's text** — 19 of 20 sampled open with harness-injected content (AGENTS.md, `<environment_context>`, `<user_instructions>`, plugin/skill boilerplate). The real message is usually the 2nd or 3rd user turn. Pi is unaffected | independent samples by the session-index workstream and by review |

On 9–15, the net effect: `pi-web-ui`'s real contribution was message chrome,
markdown, and a registry — while the tool renderers, the fallback hook, and
the diff rendering were all going to be ours regardless. DESIGN D5 records
what we build instead.

On 18–21: an earlier draft of D9 had the server keep a workspace-less
`codex app-server` alive purely to answer `thread/list`, on the mistaken
assumption that Codex sessions were only reachable through the protocol. They
are on disk, exactly like Pi's. If you find yourself about to spawn a process
to answer a *listing* question, re-read 18.

## Third round: what building the Pi adapter established

Findings 28–30 came out of implementing an adapter against a real subprocess
rather than a fixture. DESIGN's "What the wrapper chain does to process events"
is where they are acted on. Each is also pinned by a test in
`src/server/adapters/pi/process.test.ts` that was confirmed to fail against the
unfixed code.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 28 | A **failed spawn emits `error` then `close`, and never `exit`** (ENOENT gives `close` code `-2`). Reaping on `exit` alone therefore never reaps a failed spawn — the Pi adapter's readiness probe hung forever, so `start()` never rejected | direct probe against `node:child_process`, spawning a nonexistent binary |
| 29 | **`direnv` writes routine diagnostics to stderr**, so a healthy start produces stderr output. Treating stderr as an error channel reports errors on working sessions; the useful signal is the retained tail at process death | `direnv exec` observed writing to fd 2 |
| 30 | **Pi's `fork` veto is reported as `success: true`** with `data.cancelled: true`, not as an error response — a `session_before_fork` extension handler cancelling reads as a successful rewind unless the flag is checked | `pi-coding-agent/docs/rpc.md`, "fork" |

## Fourth round: what building the renderer established

Findings 31–33 came out of checking the render layer against the *tools'* own
schemas rather than against hand-written samples. Each is pinned by a test that
was confirmed to fail against the unfixed code.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 31 | **Pi's `edit` tool nests its replacements**: the arguments are `{ path, edits: [{ oldText, newText }, …] }`, an array, because one call may carry several disjoint edits. The result content is only the sentence `Successfully replaced N block(s) in <path>` — the diff and the unified patch are in `details`, which no renderer sees by default | `pi-coding-agent/dist/core/tools/edit.js`, `editSchema` and the result construction |
| 32 | **A Pi tool result can carry an image.** `read` returns `[{type:"text"},{type:"image",data,mimeType}]` for any path it detects as an image, so a card that renders `resultText()` alone shows a blank body for `read shot.png` | `pi-coding-agent/dist/core/tools/read.js`, the `mimeType` branch |
| 33 | **`toggle` fires for programmatic `<details>` changes too.** The spec queues it whenever the `open` attribute changes state, whoever changed it — so a component that auto-opens a disclosure and also listens for `toggle` reads its own change as a user action | direct probe in jsdom: setting `open` on a detached `<details>` delivers a `toggle` event |

Finding 31 is the one with reach beyond its slice: it is why the renderer
accepts *both* an `edits[]` array and a flat `oldText`/`newText` (or
`old_string`/`new_string`) pair. An adapter that maps an edit-shaped call into
`AgentMessage` should emit one of those two shapes, or register its own
renderer.

Still unverified, and the reason it matters is in DESIGN's open questions:
whether a signal to the spawned `direnv` reaches the agent two execs down
inside `bwrap`. It needs a live spawn, which the sandbox below prevents.

## Environment gotchas (learned the hard way)

- **Sandbox.** This machine runs inside a bubblewrap sandbox (`~/bin/sbox`);
  most of the filesystem is read-only. `~/src/agentpane` was granted write
  access specifically for this work. If you can write elsewhere in `$HOME`,
  the sandbox is off — warn the user.
- **Both agents need a writable state directory, and sbox will not give you
  one from inside this sandbox.** Codex initializes a sqlite state runtime
  under `~/.codex`; Pi takes a lock under `~/.pi/agent` merely to *read* its
  credential store. Both are read-only here, and running through `sbox` does
  **not** fix it — an inner bubblewrap cannot re-mount read-write what the
  outer namespace mounted read-only. Verified: `sbox -- codex app-server`
  fails with `failed to initialize sqlite state runtime`, and `sbox -- pi
  --mode rpc` returns `stopReason: "error"` with `EROFS ... auth.json.lock`.
  The workaround, which `capture_fixtures.py` implements, is a throwaway state
  dir per backend with credentials copied in:
  `CODEX_HOME` for Codex, **`PI_CODING_AGENT_DIR`** for Pi (Pi's exact
  equivalent — see `ENV_AGENT_DIR` in `pi-coding-agent/dist`).
  A failure here is quiet and looks like success: the turn "completes" in
  under a second with `stopReason: "error"` and empty content.
- **Pi RPC framing is LF-only.** Split on `\n` only; do not use Node
  `readline` (it also splits on U+2028/U+2029, which are valid inside JSON
  strings). See Pi's `docs/rpc.md` "Framing".

## Reference material (absolute paths — read these directly)

- **pipane** (server architecture to emulate, client stack to skip; Pi-only,
  old scope): `/home/asa0717/src/pipane`
  - `src/server/pi-launch.ts` — the executable-resolution seam (this is where
    sbox slots in)
  - `src/server/process-pool.ts`, `attached-session.ts` — subprocess
    lifecycle / session-to-process binding
  - `src/client/fork-modal.ts`, `session-picker.ts` — fork UI, session list
  - `src/client/tool-renderers.ts` — 663 lines of coding-tool renderers, the
    clearest evidence for how much of this is ours to write either way
  - Superseded by DESIGN decisions, useful only as contrast:
    `src/server/ws-handler.ts` + `src/client/ws-agent-adapter.ts` (WebSocket
    bridge — we use SSE, D2), `src/shared/jsonl-sync.ts` (SHA-256 delta sync —
    unnecessary on loopback, D3), and
    `patches/@mariozechner+pi-web-ui+0.55.3.patch` (see finding 14).
  - **Borrow patterns, not files.** The client stack diverges entirely, and
    the server-side API has drifted ~20 minor versions.
- **sbox** (the sandbox): `/home/asa0717/src/sandbox/sbox`. Has `pi` and
  `codex` profiles already (mounts `~/.pi/agent` / `~/.codex` rw), auto-detects
  the workspace (git root / marker), injects `codex --sandbox
  danger-full-access` so Codex doesn't run its own sandbox. Uses `--ro-bind /
  /` + `--share-net` (so Codex loopback works, but there is no network
  isolation and full-home read exposure — a known gap, not this project's
  problem).
- **`sandboxed-pi`**: `/home/asa0717/.local/bin/sandboxed-pi` —
  `exec direnv exec "$(pwd)" sbox -- pi "$@"`. Read it for the pattern only:
  the direnv step loads per-workspace env (API keys/model config) before
  entering the jail. agentpane does **not** call this script — the server
  builds `direnv exec <workspace> sbox -- <agent>` itself (D7), and there is
  no `sandboxed-codex` equivalent on PATH anyway.
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
  - `pi-agent-core/dist/agent.d.ts` — the `Agent` class we deliberately do
    *not* implement (finding 9)
  - `pi-web-ui` is **not** installed and is not a dependency. To re-check any
    finding about it: `npm pack @earendil-works/pi-web-ui@0.75.3`.

## Workflow for building

Steps 1–3 below are done: `src/` is scaffolded, the interfaces are in place,
and session-index and the Pi adapter are built. `docs/WORKSTREAMS.md` carries
the current state and the pickup order. What remains durably true:

1. Re-run the probes in `resources/probes/` when a CLI's behaviour is in
   question — versions drift, and both agents are moving targets.
2. Read `docs/DESIGN.md`'s Decisions section before changing anything
   structural. It carries the reasoning, so you can tell when a premise has
   expired rather than guessing whether a decision still applies.
3. Follow the build order in DESIGN: Pi-only vertical slice first, Codex
   adapter against fixtures second. The mapping is the only hard part and it
   should land against a UI that already works.
4. Keep `resources/codex-protocol/` as the source of truth for Codex types —
   decide whether to import them into `src/` or reference them; do not
   hand-write Codex types.

`docs/DESIGN.md` is the durable document. This one is the evidence behind it,
and stays useful for as long as its findings are load-bearing.
