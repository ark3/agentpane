# Handoff

You are picking up **agentpane** with none of the design conversation's context.
This document gives you ground truth: what is already proven, where the reference material lives, and how to re-verify anything before you trust it.

**The build is integrated.**
This document is the evidence base rather than the starting point — read `docs/DESIGN.md` for the decisions, `docs/WORKSTREAMS.md` for build-slice status, and `card list --open` for what is left.
Status lives only in WORKSTREAMS' Status table, and every outstanding item — defect, deferral, open question, unproven claim — lives only in the card deck.
Cite an id from elsewhere; do not restate one.
Two sections here stay live regardless: **Environment gotchas**, which will cost you an afternoon if you skip it, and **Reference material**, which is where the authoritative protocol docs live.
The findings tables are the record of how each decision was established; consult them when a premise looks wrong.

The one rule that produced this design: **verify at the source, don't reason from memory.**
Every claim below was checked against a running CLI or an extracted type — not recalled.
Hold yourself to the same bar.
The most expensive defect found during the build was an unexamined assumption about which events `node:child_process` emits when a spawn fails.

## What agentpane is

A local web UI for coding agents.
One server process owns one sandboxed agent subprocess per session, owns the transcript, and streams it to a browser over SSE.
It drives **three** backends behind one adapter contract: **Pi**, **Codex**, and **Claude Code**.

pipane proved the architecture (sandboxed subprocess + a browser view that can drop and repaint), and agentpane keeps those patterns.
It does **not** keep pipane's client stack: the original plan to build on `pi-web-ui` was reversed after investigation — see "Superseded conclusions" below and D5 in `docs/DESIGN.md`.

## Validated facts (with evidence)

Every load-bearing assumption was reproduced live.
Re-run the probes in `resources/probes/` to re-confirm.

| # | Claim | How it was verified |
|---|-------|---------------------|
| 1 | `pi-web-ui@0.75.3` is maintained and exports the renderers (`MessageList`, `ChatPanel`, `registerMessageRenderer`, `registerToolRenderer`) | `npm view @earendil-works/pi-web-ui`; extracted `dist/*.d.ts` from the tarball |
| 2 | The UI renders **`AgentMessage[]`** (from `@earendil-works/pi-agent-core`), not raw protocol events | `MessageList.d.ts`: `messages: AgentMessage[]` |
| 3 | Pi's `--mode rpc` `message_end` events **already are `AgentMessage` objects** (role, content blocks, usage, stopReason, model, timestamp) | `resources/probes/pi_rpc_probe.sh`, live turn on pi 0.84.1 |
| 4 | `codex app-server` speaks a real protocol over **stdio** (`stdio://` is the default `--listen`), so it is sbox-transparent like Pi | `codex app-server --help`; `resources/probes/codex_turn_probe.py` |
| 5 | Codex ships its **entire protocol as generated TypeScript + JSON Schema** (`codex app-server generate-ts` / `generate-json-schema`) | Generated bindings copied to `resources/codex-protocol/` (642 files, 550 of them under `v2/`) |
| 6 | A full Codex turn works: `initialize` → `thread/start` → `turn/start` → streaming `item/agentMessage/delta` → `item/completed` → `turn/completed` | `resources/probes/codex_turn_probe.py`, live turn on codex-cli 0.147.0 |
| 7 | **Both** backends support fork-from-past natively: Pi `fork`/`get_fork_messages`; Codex `thread/fork` + `thread/rollback` | Pi `docs/rpc.md`; Codex `resources/codex-protocol/ClientRequest.ts` **— corrected by findings 43–48: this flattens two operations, and `thread/rollback` is deprecated. Nothing here had been run; OW-mewiga ran it.** |
| 8 | The sandbox seam works transparently over stdio | Proven in production: pipane ran `sandboxed-pi` (`~/.local/bin/sandboxed-pi` → `sbox -- pi`) |

**No showstopper was found in this first round.**
The main engineering task it identified was the Codex `ThreadItem` → `AgentMessage` mapping; that mapping has since landed (see `docs/DESIGN.md`).

## Second round: one reversal, and further findings

Facts 1 and 2 above are true as stated, but the *conclusion* originally drawn from them — build the client on `pi-web-ui` — was **reversed**; findings 9–15 are why.
Findings 16–25 are new ground covered while settling the transport and session model and while capturing protocol fixtures.
Everything here is reproducible from the 0.75.3 tarball (`npm pack @earendil-works/pi-web-ui@0.75.3`), the installed packages, the session directories named in 18, and `resources/probes/capture_fixtures.py`.

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

On 9–15, the net effect: `pi-web-ui`'s real contribution was message chrome, markdown, and a registry — while the tool renderers, the fallback hook, and the diff rendering were all going to be ours regardless.
DESIGN D5 records what we build instead.

On 18–21: an earlier draft of D9 had the server keep a workspace-less `codex app-server` alive purely to answer `thread/list`, on the mistaken assumption that Codex sessions were only reachable through the protocol.
They are on disk, exactly like Pi's.
If you find yourself about to spawn a process to answer a *listing* question, re-read 18.

## Third round: what building the Pi adapter established

Findings 28–30 came out of implementing an adapter against a real subprocess rather than a fixture.
DESIGN's "What the wrapper chain does to process events" is where they are acted on.
Each is also pinned by a test in `src/server/adapters/pi/process.test.ts` that was confirmed to fail against the unfixed code.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 28 | A **failed spawn emits `error` then `close`, and never `exit`** (ENOENT gives `close` code `-2`). Reaping on `exit` alone therefore never reaps a failed spawn — the Pi adapter's readiness probe hung forever, so `start()` never rejected | direct probe against `node:child_process`, spawning a nonexistent binary |
| 29 | **`direnv` writes routine diagnostics to stderr**, so a healthy start produces stderr output. Treating stderr as an error channel reports errors on working sessions; the useful signal is the retained tail at process death | `direnv exec` observed writing to fd 2 |
| 30 | **Pi's `fork` veto is reported as `success: true`** with `data.cancelled: true`, not as an error response — a `session_before_fork` extension handler cancelling reads as a successful rewind unless the flag is checked | `pi-coding-agent/docs/rpc.md`, "fork" |

## Fourth round: what building the renderer established

Findings 31–33 came out of checking the render layer against the *tools'* own schemas rather than against hand-written samples.
Each is pinned by a test that was confirmed to fail against the unfixed code.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 31 | **Pi's `edit` tool nests its replacements**: the arguments are `{ path, edits: [{ oldText, newText }, …] }`, an array, because one call may carry several disjoint edits. The result content is only the sentence `Successfully replaced N block(s) in <path>` — the diff and the unified patch are in `details`, which no renderer sees by default | `pi-coding-agent/dist/core/tools/edit.js`, `editSchema` and the result construction |
| 32 | **A Pi tool result can carry an image.** `read` returns `[{type:"text"},{type:"image",data,mimeType}]` for any path it detects as an image, so a card that renders `resultText()` alone shows a blank body for `read shot.png` | `pi-coding-agent/dist/core/tools/read.js`, the `mimeType` branch |
| 33 | **`toggle` fires for programmatic `<details>` changes too.** The spec queues it whenever the `open` attribute changes state, whoever changed it — so a component that auto-opens a disclosure and also listens for `toggle` reads its own change as a user action | direct probe in jsdom: setting `open` on a detached `<details>` delivers a `toggle` event |

Finding 31 is the one with reach beyond its slice: it is why the renderer accepts *both* an `edits[]` array and a flat `oldText`/`newText` (or `old_string`/`new_string`) pair.
An adapter that maps an edit-shaped call into `AgentMessage` should emit one of those two shapes, or register its own renderer.

## Fifth round: what the live vertical slice established

Findings 34–38 came out of running the built server against a real `codex app-server` over the production REST/SSE path, rather than against fixtures.
Finding 34 settles DESIGN's third open question — for Codex.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 34 | **A signal to the server does reach the agent through the whole wrapper chain.** SIGTERM to the server exits the native `codex app-server` leaf two `exec`s down inside `bwrap`, leaving no orphan. The live chain is `bun server → bwrap → bwrap → node launcher → native codex`; `direnv` and the Python sbox wrapper `exec` into it rather than surviving as separate processes. Confirmed for Pi too — see 39 | `resources/probes/agentpane_codex_smoke.py`; run-scoped process tree captured before and after SIGTERM |
| 35 | **The npm Codex launcher is itself a Node process whose argv also says `app-server`**, so counting workers by argv reports two agents where one is running. The live worker is the leaf whose `comm` is `codex` | same run; the launcher topology in its recorded process tree |
| 36 | **An adapter owns its subprocess before `start()` resolves** — Codex across its `initialize` round trip, Pi across its `get_state` probe. Teardown that walks only the process table cannot see it, and `disposeAll()` returning is the server's licence to exit, so that window orphaned an agent on every attach that raced it | `src/server/http/session-manager.test.ts`, "teardown racing a startup" — each case confirmed failing first |
| 37 | **`submit()` resolving is a promise that the backend admitted the turn.** The prompt route relays a rejection as a 500, and the browser answers by preserving the draft to send again. Any round trip an adapter runs *after* admission must therefore be unable to fail the submit, or the user is invited to resend a prompt that is already running | `src/server/adapters/pi/process.test.ts`, the first-prompt id probe |
| 38 | **`/proc/<pid>/stat` cannot be split on whitespace.** `comm` sits in parentheses and may itself contain spaces and parentheses, so `split()[3]` is not the parent pid — it silently drops that process and every descendant hanging off it. Parse after the final `)` | direct probe against a synthesised stat line and against `ps` for every visible pid |

Findings 36 and 37 are the same lesson from two directions: the moment a subprocess exists is earlier than the moment our bookkeeping says it does, and the moment a turn is committed is earlier than the moment `submit()` returns.
Both windows are milliseconds wide and both were reachable on every prompt.

## Sixth round: what running Pi live established

Findings 39–42 came out of the first execution of the production Pi spawn chain.
Nothing had run it before: `capture_fixtures.py` deliberately bypasses sbox because it only needs the protocol, so `direnv exec <workspace> sbox -- pi --mode rpc` had been assembled, unit-tested against a fake, and never once executed.
All four are pinned by `resources/probes/agentpane_pi_smoke.py`.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 39 | **The production Pi chain works, and a signal reaches through it.** `bun server → bwrap → bwrap → pi`, one agent, and SIGTERM to the server leaves no run-scoped worker. With 34, this settles DESIGN's third open question for both Pi and Codex | live run; process tree captured at attach and again before shutdown |
| 40 | **Pi's process reports `comm=pi` with a command line of exactly `pi`.** It is a `#!/usr/bin/env node` script, so both the name and the missing flags are surprising: setting `process.title` in Node overwrites the argv memory the command line is read from. The only processes still carrying `--mode rpc` are the `bwrap` wrappers, so an agent identified by argv is either invisible or triple-counted | `/proc/<pid>/{comm,cmdline}` for the live agent and every wrapper above it |
| 41 | **Pi names its session file during `start()`, not on the first prompt.** D9 says a `virtual` session has no JSONL path until its first prompt writes one, and `PiAdapter` carries a second `get_state` probe in `submit()` for exactly that case. On 0.84.1 the file already exists when `start()`'s probe answers, so the id changes during **attach** and that second probe never fires. The adapter contract is satisfied either way — it promises `ref` is unstable at two points, not that it moves at exactly one — but code written for only the prompt-time rename will miss this | live `renamed` event, observed before any prompt was sent |
| 42 | **Pi ran a shell tool with no approval dialog.** No `extension_ui_request` reached the wire; the turn produced `thinking` and `toolCall` blocks and completed. Note the harness copies `trust.json` into its temporary state dir, so this shows the sandboxed path does not *add* a prompt — not that Pi never asks | `--tool-check` run; `agent_requests_seen` empty |

Finding 41 is the one to be careful with: it means the first-prompt materialisation path is currently dead code against this Pi version.
Do not delete it on that basis — a `virtual` session whose backend has not yet written a file is exactly what D9 describes, and the behaviour here may be a property of how `pi --mode rpc` starts rather than a promise.

## Seventh round: the first fork ever run on either backend (OW-mewiga)

Finding 7 asserted fork support from `rpc.md` and the Codex bindings alone; nothing had run a fork on either backend.
Findings 43–48 are the four cells of `{Pi, Codex} × {rewind, new session}` run live on this laptop, plus the two command-surface deltas OW-mewiga asked to bring back.
All are reproduced by `resources/probes/fork_probe.py` (pi 0.84.2 / codex-cli 0.147.0), with a forked session fixture per backend at `resources/fixtures/{pi,codex}/fork.jsonl`.
Finding 7 is corrected below; DESIGN's fork goal (`DESIGN.md:21`) was likewise flattened and is now split into the two operations.

| # | Finding | How it was verified |
|---|---------|---------------------|
| 43 | **Pi's `fork` is copy-on-write, not the in-place rewind its adapter docblock claims.** `pi/process.ts:343` says `fork` "rewinds the active branch of the SAME session file in place." On 0.84.2 it does not: the active file is left **byte-identical** (sha unchanged, its tail still the abandoned assistant reply), and the post-fork re-ask lands in a **new** file whose header carries a `parentSession` pointer back to it. The abandoned tail therefore always survives on disk. Separately, 81 of 419 corpus files carry in-file sibling branches under one parent id — the TUI `/fork` shape — so both routes preserve and neither destroys. No destructive-rewind warning is warranted, which was the open question the cell existed to settle | `resources/probes/fork_probe.py` `pi_rewind` cell; corpus tree scan over `~/.pi/agent/sessions` |
| 44 | **Pi's `clone` takes NO entry id** (the highest-value unknown in OW-mewiga). `rpc.md` "clone": it duplicates the *whole active branch* into a new session at the current position — there is no per-entry parameter. So branching-into-a-new-session-from-a-chosen-point on Pi is a composition: `fork` (rewind) to the point, then `clone`; or `clone` then `switch_session` into the copy. The RPC process does **not** auto-switch to the clone (`get_state` still reports the original file), so a caller that wants to work in it must `switch_session` first. The probe clones, switches, and drives a completed turn inside the clone | `resources/probes/fork_probe.py` `pi_new_session` cell; `rpc.md` "clone" |
| 45 | **Codex `thread/fork` mints a new thread whose on-disk rollout carries `forked_from_id`.** `thread/fork` with `lastTurnId` (inclusive) returns a new thread id; a real turn drives to a completed `agentMessage` inside it; the parent rollout is untouched. The lineage is on disk, not only over the protocol: `session_meta.payload.forked_from_id` (snake_case) mirrors the `Thread.forkedFromId` (camelCase) of finding 21. 21 of 597 corpus files carry it — `source: cli` / `thread_source: user` for real user forks, and a `subagent` variant for spawned agents | `resources/probes/fork_probe.py` `codex_new_session` cell; `forked_from_id` census over `~/.codex/sessions` |
| 46 | **Codex still cannot rewind in place — `thread/rollback` remains DEPRECATED.** The generated schema for 0.147.0 (`ClientRequest.json` → `ThreadRollbackParams`) carries `description: "DEPRECATED: \`thread/rollback\` will be removed soon."`, and its own docstring warns it only edits history and does not revert file changes. There is no non-deprecated in-place rewind command. "Codex cannot rewind" is a result, not a gap in the probe: rewind on Codex is expressed as a new-session fork through an earlier turn (finding 45), which is exactly the adapter's design (`codex/adapter.ts:370`) | `resources/probes/fork_probe.py` `codex_rewind` cell reads the live schema |
| 47 | **`rpc.md` documents 32 RPC commands; `PiCommand` transcribes 11.** The 21 absent, all real and simply never sent: `steer`, `follow_up`, `new_session`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `clone`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`. Fork-relevant among these: **`clone`** (finding 44), **`switch_session`** (drive a turn in a clone), **`new_session`** (with optional `parentSession` lineage), and **`get_tree`** (`DESIGN.md:520` lists it but it is not transcribed). `PiCommand`'s docstring already says it is a deliberate subset; this records the exact delta so the next fork/tree work knows what is upstream vs. untranscribed | `diff` of `#### ` command headers in `rpc.md` §Commands against `type: "…"` arms of `PiCommand` (`pi/protocol.ts`) |
| 48 | **Codex's `ClientRequest.json` carries 133 request methods; the adapter speaks ~11.** The generated schema (`codex app-server generate-json-schema --experimental`) enumerates 133 client→server methods. The adapter uses `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/compact/start`, `turn/start`, `turn/interrupt`, and reads `model/list`. Directly fork/rewind-relevant and unused: **`thread/rollback`** (deprecated, finding 46), **`thread/list`** (finding 21, lineage over the protocol), **`thread/turns/list`** / **`thread/items/list`** (turn granularity for fork points without a full `thread/read`), and **`thread/delete`** / **`thread/archive`** (managing the threads a fork multiplies). `ThreadForkParams` also offers a `path`-based fork and per-fork config overrides (`model`, `sandbox`, `cwd`) the adapter does not pass | `ClientRequest.json` method census vs. `client.request(...)` call sites in `codex/adapter.ts` |

On finding 7's correction: "both backends support fork-from-past natively" was true but flat — it collapsed two operations that behave differently per backend.
**New-session fork** is native and symmetric: Pi `clone` (whole branch) or `fork`+`clone`, Codex `thread/fork` (turn-granular), both leaving lineage on disk.
**In-place rewind** is not symmetric: Pi's `fork` does it (as copy-on-write, preserving the old branch), Codex has no supported command for it and expresses it as a new-session fork instead.
The table's finding-7 row is unchanged as a record of what was believed; this round is its correction.

## Environment gotchas (learned the hard way)

- **Home server sandbox.**
  The home server's session environment runs inside a bubblewrap sandbox (`~/bin/sbox`); most of the filesystem is read-only.
  `~/src/agentpane` was granted write access specifically for this work.
  If you can write elsewhere in `$HOME`, the sandbox is off — warn the user.
  One consequence bites dispatch: a dispatched worktree must live *inside* the repo tree (`.worktrees/<id>`, gitignored), because it is the only path mounted read-write — a worktree anywhere outside it (`~/src/`, `/tmp`, a sibling of the repo) fails with `Read-only file system`.
  `card worktree <id>` satisfies this by construction: it puts the tree at `<main checkout>/.worktrees/<id>`.
  See `AGENTS.md`, "Dispatching an implementer".
- **Pi and Codex each need a writable state directory, and sbox will not give them one from inside this sandbox.**
  Codex initializes a sqlite state runtime under `~/.codex`; Pi takes a lock under `~/.pi/agent` merely to *read* its credential store.
  Both are read-only here, and running through `sbox` does **not** fix it — an inner bubblewrap cannot re-mount read-write what the outer namespace mounted read-only.
  Verified: `sbox -- codex app-server` fails with `failed to initialize sqlite state runtime`, and `sbox -- pi --mode rpc` returns `stopReason: "error"` with `EROFS ... auth.json.lock`.
  The workaround, which `capture_fixtures.py` implements, is a throwaway state dir per backend with credentials copied in: `CODEX_HOME` for Codex, **`PI_CODING_AGENT_DIR`** for Pi (Pi's exact equivalent — see `ENV_AGENT_DIR` in `pi-coding-agent/dist`).
  A failure here is quiet and looks like success: the turn "completes" in under a second with `stopReason: "error"` and empty content.
  With that state dir, a **live spawn from inside this sandbox does work** — it is how `resources/probes/agentpane_codex_smoke.py` drives a real Codex through the built server, and how finding 34 was settled.
  Earlier drafts of this document said the sandbox prevented one; what it prevents is a spawn that inherits the read-only `~/.codex`.
- **Pi RPC framing is LF-only.**
  Split on `\n` only; do not use Node `readline` (it also splits on U+2028/U+2029, which are valid inside JSON strings).
  See Pi's `docs/rpc.md` "Framing".

## Reference material on the work laptop

The absolute paths below are evidence addresses on the work laptop, not portable setup instructions.

- **pipane** (server architecture to emulate, client stack to skip; Pi-only, old scope): `/home/asa0717/src/pipane`
  - `src/server/pi-launch.ts` — the executable-resolution seam (this is where sbox slots in)
  - `src/server/process-pool.ts`, `attached-session.ts` — subprocess lifecycle / session-to-process binding
  - `src/client/fork-modal.ts`, `session-picker.ts` — fork UI, session list
  - `src/client/tool-renderers.ts` — 663 lines of coding-tool renderers, the clearest evidence for how much of this is ours to write either way
  - Superseded by DESIGN decisions, useful only as contrast: `src/server/ws-handler.ts` + `src/client/ws-agent-adapter.ts` (WebSocket bridge — we use SSE, D2), `src/shared/jsonl-sync.ts` (SHA-256 delta sync — unnecessary on loopback, D3), and `patches/@mariozechner+pi-web-ui+0.55.3.patch` (see finding 14).
  - **Borrow patterns, not files.**
    The client stack diverges entirely, and the server-side API has drifted ~20 minor versions.
- **sbox** (the sandbox): `/home/asa0717/src/sandbox/sbox`.
  Has `pi` and `codex` profiles already (mounts `~/.pi/agent` / `~/.codex` rw), auto-detects the workspace (git root / marker), injects `codex --sandbox danger-full-access` so Codex doesn't run its own sandbox — but that flag is a no-op for `app-server`, which defaults threads to `read-only`; the effective policy is set per `thread/start` (OW-37).
  Uses `--ro-bind / /` + `--share-net` (so Codex loopback works, but there is no network isolation and full-home read exposure — a known gap, not this project's problem).
- **`sandboxed-pi`**: `/home/asa0717/.local/bin/sandboxed-pi` — `exec direnv exec "$(pwd)" sbox -- pi "$@"`.
  Read it for the pattern only: the direnv step loads per-workspace env (API keys/model config) before entering the jail. agentpane does **not** call this script — the server builds `direnv exec <workspace> sbox -- <agent>` itself (D7), and there is no `sandboxed-codex` equivalent on PATH anyway.
- **omnigent** (reference only, do not depend on it): `/home/asa0717/src/omnigent`.
  It solves a much larger multi-agent/enterprise problem; its Codex integration (`omnigent/codex_native_app_server.py`) is a worked example of driving `app-server`, but you now have the official generated bindings, so prefer those.
- **Pi packages** (current scope, on disk): `/home/asa0717/.bun/install/global/node_modules/@earendil-works/`
  - `pi-coding-agent/docs/rpc.md` — the full Pi RPC protocol (authoritative)
  - `pi-coding-agent/docs/sdk.md` — the in-process SDK (NOT used here; we spawn subprocesses for sandboxing — see DESIGN non-goals)
  - `pi-agent-core/dist/types.d.ts` — `AgentMessage`
  - `pi-ai/dist/types.d.ts` — `UserMessage`/`AssistantMessage`/ `ToolResultMessage` and the content blocks (`text`, `thinking`, `toolCall`, `image`)
  - `pi-agent-core/dist/agent.d.ts` — the `Agent` class we deliberately do *not* implement (finding 9)
  - `pi-web-ui` is **not** installed and is not a dependency.
    To re-check any finding about it: `npm pack @earendil-works/pi-web-ui@0.75.3`.

## How to use this evidence now

1. Re-run the probes in `resources/probes/` when a CLI's behaviour is in question — versions drift, and all three agents are moving targets.
2. Read `docs/DESIGN.md`'s Decisions section before changing anything structural.
   It carries the reasoning, so you can tell when a premise has expired rather than guessing whether a decision still applies.
3. Keep `resources/codex-protocol/` as the source of truth for Codex types; do not hand-write them.

`docs/DESIGN.md` is the durable document.
This one is the evidence behind it, and stays useful for as long as its findings are load-bearing.
