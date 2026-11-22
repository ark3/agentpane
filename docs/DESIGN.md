# Design

agentpane is a local web UI for coding agents.
This document describes the intended shape and the reasoning behind it.
It is intent, not orders: where it names a specific file or type, that is verified ground truth (see `docs/MANUAL_TESTING.md`); where it describes structure, prefer clarity and good factoring over literal adherence.

## Goals

- One clean web UI that renders coding-agent conversations well: streaming text, thinking, tool calls, diffs, images, token/cost.
- **Pluggable backends behind one adapter contract:** Pi (`pi --mode rpc`), Codex (`codex app-server`), and Claude Code (`claude -p` over stream-json).
  Adding a backend should be a new adapter, not a core change — the third, OW-beripo, landed as exactly that.
- **Per-workspace sandboxing:** every agent runs inside `sbox`, jailed to its workspace, with that workspace's credentials/env.
- **One server, all sessions, one UI.**
  The server manages a set of agent subprocesses; the browser is a stateless view that can reconnect and repaint.
- Fork a conversation from any past user message.
  This is two operations, not one, and they are not symmetric across backends (HANDOFF findings 43–48 and OW-mayuza): **rewind in place** (Pi `fork`, copy-on-write: the active file is left byte-identical and the process's active file moves to a new one, so the old branch survives; Codex and Claude Code have no supported in-place rewind) and **fork into a new session** (Pi `clone`/`fork`+`clone`; Codex `thread/fork`; Claude Code `--resume --resume-session-at <entry> --fork-session`).
  Pi and Codex record lineage on disk; Claude Code does not.
- Well-factored and well-tested from the start.

## Non-goals

- **Not** an omnigent replacement: no policy engine, no credential proxy, no cloud sandboxes, no multi-agent orchestration, no model routing, no conversation database beyond what the agents persist themselves.
- **Not** using Pi's in-process SDK (`createAgentSession`).
  In-process is off the table because it cannot be sandboxed per workspace — the agent would run inside the server.
  We always spawn subprocesses through sbox.
- **Not** using Pi's `RpcClient` helper: it hardcodes its own `spawn("node", [cliPath])` with no executable override, so it cannot be wrapped in sbox.
  We own the spawn and speak the protocol ourselves (importing Pi's *types* is fine).
- **Not** building on `pi-web-ui` / `mini-lit`.
  See D5 — this reverses the original plan, and the evidence is HANDOFF findings 9–15 in `docs/MANUAL_TESTING.md`.
- **Not** remotely accessible.
  Loopback only; see D8.
- Not a general chat client; the backends are coding agents with a workspace.

## Architecture

```
Browser (SPA, Svelte 5 + Vite), or the Emacs helper
   │  HTTP:       the static bundle, and the upgrade to the socket
   │  WebSocket:  one per client (D31) — commands (prompt/abort/fork/set-model)
   │              and queries (sessions, models, fork points) in; their replies
   │              and every session's snapshots and tail upserts out, in order
   ▼
One server process (Bun)
   ├── SessionIndex:    walks the Pi, Codex, and Claude Code session stores
   │      • metadata only (id, cwd, timestamp, preview) — no process
   ├── SessionManager:  {backend, id} → { child: sbox subprocess, adapter }
   │      • spawn on attach (cwd = that session's workspace), not on list
   │      • subprocess outlives the connection; closed after 15 idle minutes or past 16 live (D12), and at shutdown
   │      • never killed by a dropped browser connection
   ├── Backend adapter (per session):  Pi | Codex | Claude Code
   │      • owns the child's stdio
   │      • owns the transcript: maintains AgentMessage[] + isStreaming
   └── serves the SPA + the socket on one loopback port
        │  (stdio pipes, sbox-transparent)
        ▼
   sbox-wrapped agent:  `sbox pi --mode rpc` | `sbox codex app-server` | `sbox claude -p ...`
        • own creds mounted by the matching sbox profile, workspace writable
```

### Why the subprocess outlives the connection

A browser refresh drops the socket but must not kill the agent.
A subprocess's lifetime is decoupled from any connection: the server, not the client, decides when it dies.
Because the server owns the transcript (D3), reconnect is a *repaint*, not a lifecycle event — the client re-subscribes and receives a fresh snapshot.

The subprocess is *not*, however, meant to be tied to the server's whole lifetime: D12 bounds it by idleness and by a count cap, reclaimed automatically, and supersedes the original "lives as long as the server" rule.
Since ark3/agentpane#31 a session idle for 15 minutes is closed, and a start past 16 live sessions closes the least recently attached one or is refused `at_capacity`, each a visible close as Detach is (D25).

### Code map

| Component | Owns | Verify against |
|---|---|---|
| **pi-adapter** | `src/server/adapters/pi/` | `resources/fixtures/pi/*.jsonl` |
| **codex-adapter** | `src/server/adapters/codex/` | `resources/fixtures/codex/*.jsonl` |
| **claude-adapter** | `src/server/adapters/claude/` | `resources/fixtures/claude/*.jsonl` |
| **session-index** | `src/server/sessions/` | the real Pi, Codex, and Claude Code session stores |
| **transport** | `src/server/http/`, `src/server/index.ts` | the wire contract, with a fake adapter |
| **renderer** | `src/client/render/` | hand-built `AgentMessage[]` samples |
| **client-shell** | `src/client/App.svelte`, `src/client/main.ts` | the running app |

### The shared interfaces

- `src/shared/protocol.ts` — the wire contract (D11).
  The event union, the socket's frames and what each command takes and answers (D31), `SOCKET_PATH`, `SessionRef`, `SessionSummary`.
- `src/server/adapters/types.ts` — `BackendAdapter`, which all adapters implement identically.

Change these interfaces deliberately: each one joins several slices.

### What each component expects of its callers

Contracts that are easy to violate, each documented again at its definition.

#### The Pi adapter

Two contracts the server has to honour, both documented at their definitions:

- **Follow `adapter.ref` through `onRefChanged`.**
  Pi's session id *is* its JSONL path (D9), which Pi names from `start()`'s `get_state` as of `pi 0.87.1`, though the file is not written until the first turn; the probe after the first `submit()` covers a Pi that has named nothing by then, and every fork moves it again.
  The adapter adopts the real `sessionFile` as soon as Pi reports one and announces it then, so a session keyed by its minted `virtual:` id will never match a file on disk.
  Until D24 (OW-nikogo) this contract read "re-read `adapter.ref` after `start()` and after the first `submit()`", and the manager polled at those points and after `fork()`.
- **`start({ resumeId })` hydrates the transcript itself**, via `get_messages`.
  The caller does not need to re-query; a resumed adapter already holds the conversation by the time `start()` resolves.

Both are now honoured, the first by the `onRefChanged` handler `SessionManager.#start` subscribes, which moves the session's container onto a renamed id through `#rename`, its one name from then on (D35 point 1), and moves a fork onto a container of its own through `#forkOnto` (D24, OW-suyinu).
The first one was *not* honoured by the merged `wip/transport`, and it is the reason a new Pi session was unusable: the process table kept it keyed under its `virtual:` id forever, so it listed twice, was never findable on disk, and re-opening it spawned a second agent on the same session file.
If you write another adapter, `ref` is not stable — fire `onRefChanged` where it changes, before anything else you emit under the new id, and the server will follow.

#### The transport

- **Drive turns through `SessionManager.submit`, not `adapter.submit`.**
  That is where the prompt joins the session's queue (D24, OW-sewewe) and clears its error and its `virtual` flag.
  The rename above no longer depends on it: the manager hears it through `onRefChanged` whoever drove the turn.
- **`SessionSummary.ref` in the reply to `sessions/attach` is authoritative** and may differ from the ref it was asked for, for the same reason.
- **A client keys what it holds for a live session by its `handle`**, which every per-session event carries beside the ref and a rename never moves (D24, OW-suyinu), and takes the ref from the events as an attribute that may change under it.
  The browser's reducer does (OW-kimaya): an event under a known handle whose `session` is a new ref moves the view, the summary carrying that handle and the selection onto it.
  agentpane-mode does the same since OW-danifa, taking the ref from any notification under the handle; since D32 the helper sends every per-session notification under the view id of the buffer bound to its handle, the snapshot that answers an attach among them, by which `agentpane--notified-buffer` in `emacs/agentpane.el` finds the buffer that asked, which takes the handle from it (ark3/agentpane#70; from OW-wukako until then a `token` agentpane-mode minted per attach tagged that snapshot, and before that `askedFor`, the ref it asked for).
  The attach's reply could not carry that link: as of jsonrpc.el 1.0.29 on Emacs 31.1, a reply to an asynchronous request that arrives while a synchronous one is outstanding is held back as an "anxious continuation" until that one returns, while notifications arriving meanwhile are handled at once (`docs/MANUAL_TESTING.md`, "jsonrpc.el runs an async reply after later notifications").
  No event says a rename, on either wire, since OW-mofuho retired the `renamed` event and the helper's `session/renamed` that forwarded it: the server sends a snapshot under the handle carrying the new ref.
  A new ref under a handle a client already holds means one conversation took a new id, and nothing else does: the old id reaches nothing from then on (D35 point 1), an attach or a prompt by it answering `not_found` and a preview `gone`, and no *event* will ever carry it again, so a client is right to move its selection across.
  A fork never sends one, on any backend (OW-suhoto) — a fork creates a second conversation under a handle of its own and the parent keeps its own id, so all a fork tells other clients is `sessions-changed`, and on Pi, whose fork moves the process off the parent, `ended` under the parent's handle (D26, OW-sodohi).
- **The socket's upgrade rejects a non-loopback `Origin`** (D8), **and its first frame must be a `hello` carrying the token** (D29, D31 point 5).
  Nothing to do from the app; it matters if you ever drive the socket from a page served from somewhere else, or from a script, which reads the token from the file the server keeps it in (`resources/probes/agentpane_live_support.ts`).
- **HTTP answers only the static bundle and the upgrade** (D31 point 1).
  Every other path under `/api` is a 404, so there is nothing left to `curl`; a script speaks the socket.

#### The renderer

- **Mount `Transcript` and nothing else.**
  `src/client/render/index.ts` is the whole surface: `Transcript` takes `{ messages, isStreaming, reading, editingIndex, onedit }`, and `registerToolRenderer(name, component)` teaches it a backend-specific tool.
  `reading` (OW-51) elides tool and thinking chrome; it changes what renders, never what the caller passes in.
  `editingIndex` and `onedit` (OW-hezidi) mark the user message being edited and offer the edit control; omit `onedit` for a read-only preview.
- **The design tokens live in `src/client/app.css`**, in its `:root` block and the theme variants beside it, so the shell and the transcript share one palette.
  `Transcript.svelte` defines none of its own; a renderer mounted without `app.css` renders unstyled.
- **An edit-shaped tool call must carry its replacements as either an `edits[]` array or a flat `oldText`/`newText` (or `old_string`/`new_string`) pair**, or the card renders no diff.
  Pi's own shape is the array (HANDOFF 31).
  This is the one place the renderer cares what an adapter puts in `ToolCall.arguments`; everything else degrades to the default card.
- **Upsert the tail message in place.**
  The `{#each}` key is `index:role:timestamp`, so replacing the tail `AgentMessage` object mid-turn updates the existing DOM rather than rebuilding it — which is what keeps disclosure state and the markdown throttle alive.
  Pi keeps `timestamp` stable from `message_start` to `message_end`; an adapter that renumbers it per token would repaint the whole message on every token.
- **Everything the renderer puts on the page is sanitized**, but only because the two entry points (`renderMarkdown`, `renderCode`) both end in DOMPurify.
  Anything else reaching `{@html}` is a new hole; there is no second net.

## Decisions

Each decision is a file of its own under `docs/decisions/`, named by its number, so one can be read without the rest.
Each was open in the first draft and is now settled.
The reasoning matters more than the conclusion: if a premise turns out to be wrong, revisit.

- [D1](decisions/D1.md). Runtime: Bun
- [D2](decisions/D2.md). Transport: SSE + REST, not WebSocket, until D31 put everything on one WebSocket
- [D2a](decisions/D2a.md). Server-initiated requests
- [D3](decisions/D3.md). State protocol: server-authoritative snapshot + tail upsert
- [D4](decisions/D4.md). Client framework: Svelte 5
- [D5](decisions/D5.md). Rendering: our own components, dispatching on content blocks
- [D6](decisions/D6.md). Internal contract: `AgentMessage`
- [D7](decisions/D7.md). Sandbox spawn: the server does it, no wrapper scripts
- [D7a](decisions/D7a.md). Codex approval policy: `never`, set by the adapter
- [D8](decisions/D8.md). Loopback only
- [D9](decisions/D9.md). Sessions: enumerate from the filesystem, and a listing spawns nothing
- [D10](decisions/D10.md). Pi types: dev-dependency, type-only imports
- [D11](decisions/D11.md). The wire contract is a shared module
- [D12](decisions/D12.md). Bounded subprocess lifetime: idle timeout + LRU cap
- [D13](decisions/D13.md). Agentpane owns one small state file, and its marks are server state
- [D14](decisions/D14.md). Every affordance is reachable with a pointer; the keyboard types text
- [D15](decisions/D15.md). agentpane stops a streaming turn before forking it only where the backend abandons that turn anyway, which is Pi
- [D16](decisions/D16.md). A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects
- [D17](decisions/D17.md). Navigating away during a fork does not cancel it
- [D18](decisions/D18.md). Backend facts carry the version they were measured on, and only the ones that license absent code are defended against time
- [D19](decisions/D19.md). A Codex subagent shows in the parent as one collapsed tool card per collab operation, and its rollout stays in the session picker
- [D20](decisions/D20.md). A fork point names its transcript index, and a message no point names is not editable
- [D21](decisions/D21.md). Each open of the socket is followed by one session listing
- [D22](decisions/D22.md). The Emacs client is a native `agentpane-mode` over a JSON-RPC helper agentpane owns, not `agent-shell` over an ACP shim
- [D23](decisions/D23.md). A conversation's model and effort are read back from its store's last turn, never kept by agentpane
- [D24](decisions/D24.md). A live session is keyed by a handle agentpane mints, its mutations run one at a time, a hydrate merges history with the live stream, and a guard that misses a case means the state has the wrong owner
- [D25](decisions/D25.md). Only a request that makes a session live starts an agent, and a client that loses its socket holds nothing live
- [D26](decisions/D26.md). The server says a handle has ended, and the preview says a ref is gone
- [D27](decisions/D27.md). A session's row carries a name, a mark and its fork parent, and both clients label it by one rule
- [D28](decisions/D28.md). The socket's events own session state, and a reply only ends its request
- [D29](decisions/D29.md). The socket's first frame carries a bearer token, and every request must name a loopback host
- [D30](decisions/D30.md). A chain of requests that must all complete is one server operation
- [D31](decisions/D31.md). One WebSocket carries commands, replies and events
- [D32](decisions/D32.md). agentpane-mode's buffers are views the Emacs helper routes by, and the helper holds what a view has in flight
- [D33](decisions/D33.md). agentpane-mode forks only by an edit, as the browser does, and marks the messages it can fork at
- [D34](decisions/D34.md). An adapter takes state from its backend's events, and an attach that meets a running turn is refused rather than merged
- [D35](decisions/D35.md). A live session answers to one name, a start has a deadline, and a close names a handle

## The backend adapter contract

The core abstraction, and it lives **server-side**.
Each backend implements one interface; the rest of the server and the whole UI know only this interface.
Every adapter's job is to produce and maintain an `AgentMessage[]` plus a streaming signal, and to expose lifecycle controls.

Sketch (refine during implementation):

```ts
interface BackendAdapter {
  // lifecycle
  start(opts: { cwd: string }): Promise<void>;   // spawn via sbox
  dispose(): Promise<void>;

  // drive a turn
  submit(text: string, images?: ImageInput[]): Promise<void>;
  abort(): Promise<void>;

  // fork-from-past
  listForkPoints(): Promise<{ id: string; text: string }[]>;
  fork(entryId: string): Promise<void>;

  // state (what the server broadcasts per D3)
  getMessages(): AgentMessage[];
  onUpdate(cb: (state: { messages: AgentMessage[]; isStreaming: boolean }) => void): Unsubscribe;

  // session controls
  setModel(model: ModelRef): Promise<void>;
  getState(): SessionState;
}
```

- **Pi adapter** is nearly identity: Pi's `message_end`/`message_start` payloads already are `AgentMessage`s; `message_update` deltas drive the streaming assembly (assemble by `contentIndex`, treat `message_end` as authoritative).
  Commands: `prompt`, `abort`, `fork`, `get_fork_messages`, `get_entries`/`get_tree`, `set_model`.
  Protocol: `rpc.md`.
- **Codex adapter** does the real translation work — see the mapping below.
- **Claude Code adapter** maps Anthropic message content blocks nearly one-to-one, merges block-level `assistant` events by message id, and treats only `result` as the end of a turn.
  Protocol: bidirectional stream-json over NDJSON.

## Codex `ThreadItem` → `AgentMessage` mapping

This is the one piece of genuine engineering.
Codex streams an *item* model; we want Pi's *message* model.
Both carry the same information.

Codex emits `item/started` and `item/completed` notifications, each wrapping a `ThreadItem` (see `resources/codex-protocol/v2/ThreadItem.ts`), plus streaming deltas (`item/agentMessage/delta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`).
Turn boundaries are `turn/started` / `turn/completed`.

Target types (`resources/codex-protocol/` for Codex; `pi-ai/dist/types.d.ts` for Pi):

| Codex `ThreadItem` | → Pi `AgentMessage` | Notes |
|--------------------|---------------------|-------|
| `userMessage` (`content: UserInput[]`) | `UserMessage` `{role:"user", content}` | map text/image content blocks |
| `agentMessage` (`text`, `phase`) | `AssistantMessage` `{role:"assistant", content:[{type:"text",...}]}` | stream via `item/agentMessage/delta`; finalize on `item/completed` |
| `reasoning` (`summary[]`, `content[]`) | `AssistantMessage` content `{type:"thinking",...}` | stream via `item/reasoning/textDelta` |
| `commandExecution` | `AssistantMessage` `{type:"toolCall"}` + `ToolResultMessage` | command + streamed output → tool call/result pair |
| `fileChange` | `toolCall` + `toolResult` (diff) | render with the `diff` package |
| `mcpToolCall`, `dynamicToolCall`, `webSearch` | `toolCall` + `toolResult` | arbitrary names — these are why D5 needs a fallback card |
| `plan` | `AssistantMessage` text | no custom block, decided below (OW-19) |
| `contextCompaction` | compaction summary message | Pi has a compaction message type; mirror it |
| `collabAgentToolCall` | `toolCall` + `toolResult`, named `subagent` | one card per collab operation, naming the child thread (D19) |

**This table is a sketch, not a registry.**
The registry is `src/server/adapters/codex/mapping.ts` — `mapItem`'s switch and the `SILENT_ITEM_TYPES` set above it, each arm carrying its own reasoning.
Two mapped types are missing here, `imageGeneration` and `imageView`, both of which produce output.
The table is deliberately not kept complete: Codex adds `ThreadItem` variants between releases, and `mapItem`'s doc comment says what happens to the ones nobody has taught it about.

**A `plan` stays assistant text, decided 2026-10-01 (OW-19).**
As of `codex-cli 0.157.1` (`resources/fixtures/codex/plan.jsonl`), a plan arrives as one `plan` item holding a short numbered markdown list, which markdown already renders as a list in both clients, so a custom block would buy nothing.
agentpane never sends plan mode, so a plan reaches a user only from a thread another client drove.
On disk the rollout wraps the same text in `<proposed_plan>` tags as a final-answer assistant message, beside a `Plan` `item_completed` record holding the bare text; since OW-luvema the preview builds the plan from that record, so the tags do not show.
A rollout on the preview's fallback path, such as one from 0.150.1 through 0.154.0, still draws the wrapped message, tags included, as every preview did before OW-luvema (`docs/MANUAL_TESTING.md`, "What the two mappers disagree on").
Nothing strips them: on 2026-10-01 none of the home server's 119 rollouts held `<proposed_plan>`.

**The `commandExecution` row is the live shape only.**
As of `codex-cli 0.155.1`, measured 2026-09-22, the live wire presents a shell run as `commandExecution`, while the rollout on disk stores it as a `custom_tool_call` named `exec` wrapping `tools.exec_command(...)` or as a `function_call` named `exec_command`.
The preview in `src/server/sessions/codex.ts` folds both stored shapes to `bash` so preview and live transcript agree; see `docs/MANUAL_TESTING.md`, "A Codex shell run is `commandExecution` live and `exec` or `exec_command` on disk (OW-jakahe)".
Since OW-luvema that folding serves only a rollout that takes the preview's own mapper (see below); any other previews the run from its `CommandExecution` record through `mapItem`.

Content-block mapping (Codex `UserInput` → Pi content), done by `userInputToContent`: `text` → `TextContent`; `image` → `ImageContent` when the URL is a `data:` URL and a text reference otherwise; `localImage`, `audio`, `localAudio`, `skill` and `mention` → text references.
Why the two local variants degrade rather than load is recorded at `userInputToContent`.
(`ContentItem`, with its `input_text`/`input_image` variants, is the *legacy* type — v2's `userMessage` does not carry it.)

**The table above is not the whole stream.**
Captured turns also carry `turn/diff/updated` (a cumulative diff for the turn), `thread/tokenUsage/updated`, `thread/status/changed`, `thread/started`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated`, and `remoteControl/status/changed`.
Token usage feeds the cost display and status changes feed the streaming signal, so some of these belong in the adapter even though they are not messages.
Read a fixture before assuming this section is exhaustive.

Fixtures currently cover `userMessage`, `reasoning`, `agentMessage`, `commandExecution`, `fileChange`, `contextCompaction` (`resources/fixtures/codex/compact.jsonl`), `collabAgentToolCall` (`resources/fixtures/codex/subagent.jsonl`, HANDOFF finding 49), and `plan` (`resources/fixtures/codex/plan.jsonl`, `codex-cli 0.157.1`).
The remaining rows — `mcpToolCall`, `dynamicToolCall`, `webSearch` — have no capture yet; add a scenario when implementing each.
`imageGeneration` has none either: on `codex-cli 0.157.1` with `gpt-5.6-luna` the model reported no `image_gen` tool in its session (`docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)").

**The preview reads the same run through the same mapper.**
A rollout's `item_completed` records name each item the live stream completed, and where they are a full copy the preview translates them into `ThreadItem`s for `mapItem` (OW-luvema).
A rollout with none, or one that stores collab calls in the `collaboration` namespace and so has records that leave those calls out, still goes through the preview's own mapper of `response_item`s: counted on the home server on 2026-10-01, 69 of the 119 rollouts, all from `codex-cli` 0.150.1 through 0.154.0, 12 of them forks holding no turn of their own.
`extractStoreTurn`'s docblock in `src/server/sessions/codex.ts` says which rollouts take which path.
Seven Codex fixtures captured on `codex-cli 0.157.1` keep the rollout of their run beside its stream, as `<scenario>.rollout.jsonl`, and `src/server/sessions/codex-conformance.test.ts` replays each through both paths and lists every place they disagree, keyed to the card that owns it.

On the Pi side, note the fixtures show Pi choosing `bash` to perform a file edit rather than a dedicated edit tool.
The tool vocabulary is not fixed, which is the practical argument for D5's default tool card.

Streaming assembly: on `item/started` create the placeholder message; on each delta append to the right content block; on `item/completed` replace with the authoritative item text.
Correlate by `itemId`.
This state machine is the thing D3 keeps server-side.

Fork: Codex `thread/fork` exposes the same `listForkPoints`/`fork` contract by reading thread items for the fork points; deprecated `thread/rollback` is not an in-place rewind path.
The fork call carries `sandbox` and `approvalPolicy` explicitly, because a fork inherits the latter from its parent and not the former (D7a).

## Spawning through sbox

The seam pipane proved: resolve the executable, then spawn.
Per D7 the server builds the command itself:

- Pi: `direnv exec <workspace> sbox -- pi --mode rpc [--model ...]` — sbox auto-detects the `pi` profile (mounts `~/.pi/agent`), workspace = git root of the spawn cwd.
- Codex: `direnv exec <workspace> sbox -- codex app-server` — sbox's `codex` profile mounts `~/.codex` rw (so the sqlite state runtime works) and injects `--sandbox danger-full-access`.
  That injection is keyed on the command name, so it applies to `codex` and not to the surrounding wrapper — but it is a **no-op for `app-server`**, which ignores the CLI flag.
  The sandbox policy that actually takes effect is set per `thread/start` by the adapter (OW-37); `danger-full-access` there, since sbox's bwrap jail is already the confinement boundary.
  "Per `thread/start`" is shorthand for all three thread-creation calls — `thread/start`, `thread/resume` and `thread/fork` — each of which carries both the sandbox and `approvalPolicy: "never"`, for the reasons in D7a.
  Spelling it out on each is not symmetry: as of `codex-cli 0.154.0` (measured 2026-09-12, OW-pibivi and OW-18) the two paths fall back to **different** sandboxes when it is omitted, so there is no one default to rely on.
  A `thread/start` with no `sandbox` key reports `readOnly`, whether or not `app-server` was spawned with the injected flag — the 0.147.0 OW-37 answer, re-measured unchanged.
  A `thread/fork` with no `sandbox` key reports `workspaceWrite`, a silent widening of the start default and a silent narrowing of the `dangerFullAccess` parent it was forked from; `approvalPolicy`, by contrast, *is* inherited.
- Claude Code: `direnv exec <workspace> sbox -- claude -p --verbose --input-format stream-json --output-format stream-json --include-partial-messages` — sbox's `claude` profile mounts `~/.claude` and injects `--permission-mode bypassPermissions`.
- **The server must spawn each subprocess with `cwd` = that session's workspace**, or sbox jails the wrong tree (or refuses if there is no git root), and `direnv` loads the wrong environment.

stdio crosses the bwrap boundary transparently (proven), so the adapter reads the same pipes whether or not sbox is present.

### What the wrapper chain does to process events

Five subprocess facts, each capable of producing a bug that looks like something else entirely; the first three were verified while building the Pi adapter.
All three backends' children run in one shell, `ChildProcessShell` in `src/server/adapters/child-process.ts`, which is where these are kept (OW-sozopu).

- **A failed spawn emits `error` and `close`, never `exit`.**
  Verified against `node:child_process`: a missing executable gives `error` (ENOENT) then `close` with code `-2`, and no `exit` event at all.
  An adapter that reaps on `exit` alone will not reap a spawn failure — the Pi adapter's readiness probe hung forever this way, so `start()` never rejected and the session simply never appeared.
  Bind `close`.
  It also fires strictly after stdio drains, so it cannot reject a command whose response is still in the pipe.
- **stderr is not an error channel.**
  `direnv` announces every `.envrc` it loads on stderr, and sbox adds its own; a healthy start writes to it.
  Raising each chunk as an adapter error puts a red banner on a working session.
  Retain a bounded tail and spend it on the death report, where it is the only account of why a process died — `EROFS ... auth.json.lock` reaches you no other way.
- **The agent is a grandchild, not the child.**
  The spawned process is `direnv`, which execs `sbox`, which runs `bwrap`, which runs the agent.
  A signal to the child *does* reach it, **verified live on Pi and Codex**: `direnv` and the `sbox` wrapper exec into the chain rather than surviving beside it, so the server's own child is the `bwrap` chain.
  Re-provable with `resources/probes/agentpane_{codex,pi}_smoke.ts`.
- **The child's stdin needs an `error` listener.**
  A write landing after the agent stopped reading goes into a pipe with no reader, and the EPIPE arrives as an `error` event on stdin; unheard, it is an uncaught exception that takes the server down.
  Measured 2026-09-30 with a child that closed its own stdin and kept running: under Bun 1.4.0, writes of 1000 and 4000 bytes survived while 8000 and 65536 bytes exited 1 with `EPIPE: broken pipe, send`, and under Node 26.8.1 a six-byte write did the same.
  So on the runtime the server uses, a long prompt or an image is enough.
  Heard, it is part of the death report, beside the exit status rather than in place of it: EPIPE is a symptom of the death, not its cause.
- **A child that outlives SIGKILL is given up on, not waited for.**
  The kill escalation is SIGTERM, a bounded grace, SIGKILL, a second bounded grace.
  A child not closed `KILL_GRACE_MS` after SIGKILL gets a synthetic exit report naming it, and teardown resolves anyway, because a shutdown that hangs forever is its own failure.
  Every caller of `kill()` has let go of its exit listeners before it kills, so that report reaches no adapter; the shell also writes the survivor to the server's stderr before `kill()` resolves, so at shutdown it is out before the server exits (OW-tozuyo).
  That report does not wait for stdio to drain, so on this path alone "`close` fires strictly after stdio drains" does not hold; a `close` arriving after it is not reported again.

## Testing strategy

- **Unit (vitest):** the adapters, especially the Codex `ThreadItem` → `AgentMessage` mapping — table-driven over the captured protocol fixtures in `resources/fixtures/`, which already cover streaming text, a tool call/result pair, and a file edit for all three backends.
  Assert on *structure* (event sequence, item types, block kinds, id correlation), never on exact model wording.
  D3 is what makes this possible without a DOM.
- **Contract tests:** feed each adapter recorded protocol transcripts; assert the common `BackendAdapter` behaviour is identical in shape across all backends.
- **Server:** SessionManager lifecycle (spawn/reap, subprocess outlives connection, reconnect→repaint), the snapshot/upsert protocol including a dropped `seq`, LF-only framing for Pi.
- **Client (vitest + @testing-library/svelte):** block dispatch, the tool renderer registry and its fallback, markdown sanitization.
- **E2E (Playwright):** a mock-LLM or scripted agent driving a real turn end to end, screenshots for the rendering you care about.
- Keep protocol fixtures in the repo so tests do not require live model calls.

`bun run test:browser` remains separate from `bun run check`: the latter is the fast browser-free gate, while browser provisioning and real layout belong to a separate run selected by the touch rules in `AGENTS.md`.
`.github/workflows/ci.yml` runs both commands as sibling jobs rather than hiding Playwright behind an environment flag in `check` (OW-49, OW-bafeja).

## Remaining open questions

Open questions are GitHub issues on `ark3/agentpane`, beside everything else outstanding, because keeping a second list here is what previously let this document drift out of step with the tracker.
A question that settles comes back as a decision under `docs/decisions/`, with its reasoning — that is what this document is for, and it is why the one below stayed.

- ~~**Whether killing the spawned process actually stops the agent.**~~
  **Settled, for Pi and Codex.**
  `direnv` and the sbox wrapper `exec` into the chain rather than surviving beside it, so the server's own child is the `bwrap` chain and a signal does reach the agent at the bottom of it.
  SIGTERM to the server left no run-scoped worker behind for either `codex app-server` or `pi --mode rpc` (HANDOFF findings 34 and 39).
  Three defects had to be fixed before that held: `dispose()` did not await the child's close on either side, and an adapter still inside `start()` was invisible to shutdown entirely (findings 36 and 37).
  Re-provable with the two harnesses in `resources/probes/`.
