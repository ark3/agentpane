# Design

agentpane is a local web UI for coding agents. This document describes the
intended shape and the reasoning behind it. It is intent, not orders: where it
names a specific file or type, that is verified ground truth (see
`HANDOFF.md`); where it describes structure, prefer clarity and good factoring
over literal adherence.

## Goals

- One clean web UI that renders coding-agent conversations well: streaming
  text, thinking, tool calls, diffs, images, token/cost.
- **Two backends behind one adapter contract:** Pi (`pi --mode rpc`) and Codex
  (`codex app-server`). Adding a third later should be a new adapter, not a
  core change.
- **Per-workspace sandboxing:** every agent runs inside `sbox`, jailed to its
  workspace, with that workspace's credentials/env.
- **One server, all sessions, one UI.** The server manages a set of agent
  subprocesses; the browser is a stateless view that can reconnect and
  repaint.
- Fork a conversation from any past user message (both backends support this
  natively).
- Well-factored and well-tested from the start.

## Non-goals

- **Not** an omnigent replacement: no policy engine, no credential proxy, no
  cloud sandboxes, no multi-agent orchestration, no model routing, no
  conversation database beyond what the agents persist themselves.
- **Not** using Pi's in-process SDK (`createAgentSession`). In-process is off
  the table because it cannot be sandboxed per workspace — the agent would run
  inside the server. We always spawn subprocesses through sbox.
- **Not** using Pi's `RpcClient` helper: it hardcodes its own
  `spawn("node", [cliPath])` with no executable override, so it cannot be
  wrapped in sbox. We own the spawn and speak the protocol ourselves
  (importing Pi's *types* is fine).
- **Not** building on `pi-web-ui` / `mini-lit`. See D5 — this reverses the
  original plan, and the evidence is in `HANDOFF.md`.
- **Not** remotely accessible. Loopback only; see D8.
- Not a general chat client; the backends are coding agents with a workspace.

## Architecture

```
Browser (SPA, Svelte 5 + Vite)
   │  REST:  static bundle, commands (prompt/abort/fork/set-model),
   │         queries (sessions, models, fork points), request replies
   │  SSE:   one multiplexed stream — transcript snapshots, tail upserts,
   │         server-initiated requests
   ▼
One server process (Bun)
   ├── SessionIndex:    walks ~/.pi/agent/sessions + ~/.codex/sessions
   │      • metadata only (id, cwd, timestamp, preview) — no process
   ├── SessionManager:  {backend, id} → { child: sbox subprocess, adapter }
   │      • spawn on attach (cwd = that session's workspace), not on list
   │      • subprocess lives as long as the server, NOT the connection
   │      • kill on explicit close / server shutdown
   ├── Backend adapter (per session):  Pi | Codex
   │      • owns the child's stdio
   │      • owns the transcript: maintains AgentMessage[] + isStreaming
   └── serves the SPA + SSE + REST on one loopback port
        │  (stdio pipes, sbox-transparent)
        ▼
   sbox-wrapped agent:  `sbox pi --mode rpc`  |  `sbox codex app-server`
        • own creds mounted (sbox pi/codex profiles), workspace writable
```

### Why the subprocess outlives the connection

A browser refresh drops the event stream but must not kill the agent. The
subprocess's lifetime is tied to the server process only. Because the server
owns the transcript (D3), reconnect is a *repaint*, not a lifecycle event —
the client re-subscribes and receives a fresh snapshot.

## Decisions

Each of these was open in the first draft and is now settled. The reasoning
matters more than the conclusion: if a premise turns out to be wrong, revisit.

### D1. Runtime: Bun

Pi and Codex are both TS-native, so we import Pi's message types and Codex's
generated bindings directly. Bun is leaner than Node and its bundled test
runner and HTTP server reduce moving parts for a single-user local app.
Nothing in the design depends on Bun specifically.

### D2. Transport: SSE + REST, not WebSocket

The server is authoritative (D3), so client→server traffic is low-volume and
command-shaped rather than RPC-heavy — the regime where SSE is comfortable.

- `EventSource` reconnects natively; under D3 recovery is just "re-snapshot",
  so we write no backoff/retry state at all.
- Everything non-streaming is a plain route (list sessions, list models, get
  fork points, set model), which is curl-able and individually visible in the
  Network tab. pipane pushed these through its WebSocket as RPC only because
  it already had the socket open.

Costs, accepted knowingly:

- **Ordering is not guaranteed across the two channels.** A POSTed prompt can
  produce SSE events before the POST response returns. Harmless under D3, but
  write code that assumes it.
- **Use one multiplexed stream**, with a session id on each event. Browsers
  cap ~6 connections per origin on HTTP/1.1 and an open `EventSource` holds
  one permanently, so a stream per session would wall at six.
- Server-initiated requests need correlation glue; see D2a.

If the client ever becomes chatty and needs constantly correlated replies,
this is the decision to revisit — a single WebSocket would then be tidier.

### D2a. Server-initiated requests

Codex's `ServerRequest` (`resources/codex-protocol/ServerRequest.ts`) is a
request *from* the agent *to* the client, carrying a `RequestId`: approval
requests, `item/tool/requestUserInput`, MCP elicitation, dynamic tool call.
The agent blocks until answered.

The adapter answers what it can itself. What genuinely needs a human goes to
the browser over SSE with its id and comes back via a REST reply route; the
adapter matches it up and responds to Codex.

**These requests are real, not theoretical.** The `tool-edit` fixture in
`resources/fixtures/codex/` contains a live `item/fileChange/requestApproval`,
answered by the capture harness, followed by `serverRequest/resolved`. An
unanswered one hangs the turn.

Still unverified: whether sbox's injected `--sandbox danger-full-access`
suppresses the exec/patch approvals specifically. The fixtures were captured
*without* sbox, so they cannot answer it. Even if it does, `requestUserInput`
and MCP elicitation are separate and still need a path to the human.

### D3. State protocol: server-authoritative snapshot + tail upsert

The adapter owns the child's stdio, so it necessarily holds the assembled
`AgentMessage[]` already. The only real question was what crosses the wire:
assembled state, or raw events the client re-reduces.

Assembled state, because the Codex item→message mapping is **stateful**
(placeholder on `item/started`, deltas correlated by `itemId`, authoritative
replace on `item/completed`). Sending raw events would split the core
abstraction across the wire and put its backend-specific half in the browser.
Server-side it stays in one place, unit-testable against fixtures with no DOM.
It also makes multi-tab and mid-turn reconnect correct for free.

The wire is loopback, so **no delta protocol** — full snapshot on attach and
on every reconnect. What loopback does *not* make free is serialization CPU:
re-serializing the whole transcript per token is quadratic over a turn. But
streaming only ever touches the tail, and completed messages are immutable, so:

- snapshot on attach, reconnect, and session switch
- `{seq, index, message}` upsert during a turn — O(1) per token
- a monotonic `seq` detects a dropped update; recovery is "re-snapshot"

This is strictly less machinery than pipane's SHA-256-verified delta sync,
which existed to survive a real network.

Re-querying the agent (Pi `get_entries`/`get_tree`, Codex `thread/read`)
remains the **cold-start** path — server restarted, or attaching to a session
that predates it. That is not an alternative to the above; it is how the
server populates a transcript it does not yet have.

### D4. Client framework: Svelte 5

The client is one long list where exactly one item mutates rapidly. Svelte's
compiled fine-grained updates suit that with no virtual-DOM diff over a long
transcript and no memoization discipline to get wrong. Scoped styles are
built in, which matters because we are hand-rolling the look, and the runtime
is small.

Lit is the credible runner-up (it would make pipane directly readable as a
model). The original reason to prefer Lit — consuming `pi-web-ui` components
— disappeared with D5, and Svelte can consume a custom element anyway if we
ever want one.

Note Svelte 5's runes differ substantially from Svelte 4.

### D5. Rendering: our own components, dispatching on content blocks

This reverses the first draft, which assumed `pi-web-ui` would save us from
rebuilding rendering. Investigation showed otherwise (evidence in `HANDOFF`):

- It ships **four** tool renderers — Bash, Calculate, GetCurrentTime, and a
  default. **None** for coding tools. pipane wrote 663 lines of its own.
- `renderMessage` statically pulls `pdfjs-dist`, `xlsx`, `docx-preview`, and
  `jszip` through a side-effect import chain, and neither package declares
  `sideEffects: false`, so it cannot be shaken out. `xlsx` also resolves from
  a CDN tarball URL rather than the npm registry.
- It has no fallback tool renderer — the hook pipane had to patch in. Codex
  emits `mcpToolCall` and `dynamicToolCall` with arbitrary names that cannot
  be pre-registered, so we need one.
- Its markdown (via mini-lit) escapes HTML with regexes over the *source*,
  then renders through `unsafeHTML` with no sanitizer on the output.

Structure — dispatch on **content blocks**, not on messages. An
`AssistantMessage.content` is an array of `text` / `thinking` / `toolCall` /
`image` blocks, which is both the real rendering unit and what Codex's items
map onto:

```
Transcript   keyed each over messages
  Message    role chrome — user / assistant / tool-result
    Block    dispatch on block.type
      Markdown · Thinking · ToolCall · Image
        ToolCall → registry lookup by tool name, default card if unknown
```

The registry is a `Map<string, Component>` with a default entry — the missing
fallback hook, in about five lines, owned by us.

Dependencies, four: `marked`, `highlight.js`, `dompurify`, `diff`. DOMPurify
is not optional: the primary use case is rendering the contents of
repositories we do not control into a page that holds a channel to an API
that spawns processes. Sanitize the parsed output. Prefer `shiki` over
`highlight.js` only once streaming is settled — it is async, which
complicates token-by-token rendering.

Known hot spot: re-parsing markdown per token on a long message. Only the
tail block changes; re-parse just that block and throttle to a frame.

On looks: nothing in a dependency confers taste. Define a type scale, a
spacing scale, and semantic color as CSS custom properties early; collapse
tool cards by default behind a one-line summary; keep thinking blocks
visually recessive. Plain scoped CSS over Tailwind — Tailwind's payoff scales
with team size and surface area, and this is a dozen components.

### D6. Internal contract: `AgentMessage`

Keep `AgentMessage` (from `@earendil-works/pi-agent-core`) as the internal and
wire shape even though we no longer use `pi-web-ui`. Pi hands it to us for
free, which makes the Pi adapter nearly an identity mapping; it is well-typed;
and the Codex mapping work is required whatever shape we pick, so inventing a
neutral one buys little and loses the Pi freebie.

### D7. Sandbox spawn: the server does it, no wrapper scripts

The server spawns `direnv exec <workspace> sbox -- <agent> ...` directly. One
seam, no PATH dependency, testable. `~/.local/bin/sandboxed-pi` exists for
pipane specifically and is not used here.

### D8. Loopback only

Bind `127.0.0.1` explicitly. No auth token, no cookie, no localhost-bypass
layer — none of which needs to exist once remote access is off the table.
(pipane binds all interfaces on purpose and gates it with a token; that is a
different product decision.)

### D9. Sessions: enumerate from the filesystem, spawn only on attach

The requirement is pipane's: see every existing session in every workspace,
create a new one in an existing or new workspace, and switch between recent
sessions quickly.

**Both backends store sessions as JSONL on disk, and both are enumerable with
nothing running.** Measured on this machine:

| | Location | Header line | Files | Walk | Read line 1 |
|---|---|---|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `{"type":"session_meta","payload":{id,cwd,timestamp,model_provider,…}}` | 583 | 0.00s | 0.18s |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `{"type":"session",…,cwd}` | 390 | 0.01s | 0.09s |

973 sessions across 28 workspaces in ~0.3s (Python). So:

- **No catalog process.** An earlier draft of this decision had the server
  keep a workspace-less `codex app-server` alive purely to answer
  `thread/list`. That is unnecessary — and it would have run into sbox
  wanting a workspace to jail to.
- **No index cache initially.** pipane caches its Pi index at
  `~/.pi/agent/cache/`, and Codex's `thread/list` has a `useStateDbOnly`
  escape hatch, so both upstreams evidently found listing slow at some point.
  Our numbers do not justify a cache yet. Leave room for one; do not build it.
- **Tolerate header drift.** 5 of 583 Codex files use an older bare
  `{id,timestamp}` header with no `cwd`. Bucket those as unknown-workspace
  rather than failing the walk. Expect more drift over time — the walk should
  never throw on a file it does not recognise.

**Three states**, from pipane, which is what makes listing everything cheap:

- `virtual` — workspace chosen, nothing on disk yet. Materialised on first
  prompt (pipane uses a `__new__` sentinel), so browsing never litters the
  backend's store with empty sessions.
- `detached` — exists on disk, no subprocess.
- `attached` — live subprocess.

**Spawn only on attach.** The list needs metadata only — id, cwd, timestamp,
and a preview taken from the first user message — all cheap to read from the
file. A session becomes `attached` when the user prompts it or opens its
transcript.

Deliberately *not* doing: parsing the on-disk JSONL into `AgentMessage[]` to
display a detached transcript without spawning. It would avoid a subprocess,
but it means a second, format-dependent mapping per backend, kept in sync with
a format we have already watched drift. One protocol→`AgentMessage` mapping per
backend is the point of the adapter contract. Transcripts come from
`thread/read` / `get_entries` on an attached session; since subprocesses
outlive connections, switching back to a recent session is instant anyway.

**Session identity is backend-qualified**: `{backend: "pi" | "codex", id}`.
Pi's id is its JSONL path; Codex's is a UUIDv7 thread id. A listed session
inherently belongs to whichever store it was found in.

**REST surface** that follows: `GET /api/sessions` returns the merged list
across both backends, sorted by recency, with an optional `cwd` filter (so
workspace-first browsing is the same query pre-filtered); `POST /api/sessions`
creates a `virtual` session from a workspace + backend + model.

Codex additionally offers `thread/list` over the protocol, with pagination,
sorting, and `cwd`/`archived`/`searchTerm` filters. We do not need it for
enumeration, but it is the better source for anything requiring Codex's own
metadata (archived state, sections, names) on an already-attached session.

### D10. Pi types: dev-dependency, type-only imports

D6 keeps `AgentMessage` as the internal contract, which means depending on
`@earendil-works/pi-agent-core` and `pi-ai` — runtime packages we want none of
the runtime from.

Take them as **devDependencies** and import with `import type` only. TypeScript
erases type-only imports, so nothing reaches the bundle. Set
`verbatimModuleSyntax: true` in tsconfig so an accidental value import is a
compile error rather than a runtime surprise. Pin the versions.

The alternative — vendoring the `.d.ts` files into `src/` — trades drift
surprise for manual sync, and loses the property that makes D6 worth having:
that Pi's own shape is what we conform to.

### D11. The wire contract is a shared module

Both ends of D2/D3 are ours, so the SSE event union and the REST
request/response types live in one module under `src/shared/` and are imported
by server and client alike. Snapshot, upsert, and server-request events are
a discriminated union on a `type` field with the `seq` and session id at the
top level.

This is the one place worth being concrete rather than leaving to
implementation judgement: the two halves are written at different times and
will drift if the contract is only described in prose.

## The backend adapter contract

The core abstraction, and it lives **server-side**. Each backend implements
one interface; the rest of the server and the whole UI know only this
interface. Every adapter's job is to produce and maintain an `AgentMessage[]`
plus a streaming signal, and to expose lifecycle controls.

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

  // requests the agent initiates (D2a); undefined for backends without them
  onRequest?(cb: (req: AgentRequest) => Promise<AgentResponse>): Unsubscribe;

  // session controls
  setModel(model: ModelRef): Promise<void>;
  getState(): SessionState;
}
```

- **Pi adapter** is nearly identity: Pi's `message_end`/`message_start`
  payloads already are `AgentMessage`s; `message_update` deltas drive the
  streaming assembly (assemble by `contentIndex`, treat `message_end` as
  authoritative). Commands: `prompt`, `abort`, `fork`, `get_fork_messages`,
  `get_entries`/`get_tree`, `set_model`. Protocol: `rpc.md`.
- **Codex adapter** does the real translation work — see the mapping below.

## Codex `ThreadItem` → `AgentMessage` mapping

This is the one piece of genuine engineering. Codex streams an *item* model;
we want Pi's *message* model. Both carry the same information.

Codex emits `item/started` and `item/completed` notifications, each wrapping a
`ThreadItem` (see `resources/codex-protocol/v2/ThreadItem.ts`), plus streaming
deltas (`item/agentMessage/delta`, `item/reasoning/textDelta`,
`item/commandExecution/outputDelta`). Turn boundaries are `turn/started` /
`turn/completed`.

Target types (`resources/codex-protocol/` for Codex; `pi-ai/dist/types.d.ts`
for Pi):

| Codex `ThreadItem` | → Pi `AgentMessage` | Notes |
|--------------------|---------------------|-------|
| `userMessage` (`content: UserInput[]`) | `UserMessage` `{role:"user", content}` | map text/image content blocks |
| `agentMessage` (`text`, `phase`) | `AssistantMessage` `{role:"assistant", content:[{type:"text",...}]}` | stream via `item/agentMessage/delta`; finalize on `item/completed` |
| `reasoning` (`summary[]`, `content[]`) | `AssistantMessage` content `{type:"thinking",...}` | stream via `item/reasoning/textDelta` |
| `commandExecution` | `AssistantMessage` `{type:"toolCall"}` + `ToolResultMessage` | command + streamed output → tool call/result pair |
| `fileChange` | `toolCall` + `toolResult` (diff) | render with the `diff` package |
| `mcpToolCall`, `dynamicToolCall`, `webSearch` | `toolCall` + `toolResult` | arbitrary names — these are why D5 needs a fallback card |
| `plan` | assistant text or a custom block | optional polish |
| `contextCompaction` | compaction summary message | Pi has a compaction message type; mirror it |

Content-block mapping (Codex `ContentItem` → Pi content):
`input_text`/`output_text` → `TextContent`; `input_image` → `ImageContent`.

**The table above is not the whole stream.** Captured turns also carry
`turn/diff/updated` (a cumulative diff for the turn), `thread/tokenUsage/updated`,
`thread/status/changed`, `thread/started`, `account/rateLimits/updated`,
`mcpServer/startupStatus/updated`, and `remoteControl/status/changed`. Token
usage feeds the cost display and status changes feed the streaming signal, so
some of these belong in the adapter even though they are not messages. Read a
fixture before assuming this section is exhaustive.

Fixtures currently cover `userMessage`, `reasoning`, `agentMessage`,
`commandExecution`, and `fileChange`. The remaining rows — `mcpToolCall`,
`dynamicToolCall`, `webSearch`, `plan`, `contextCompaction` — have no capture
yet; add a scenario when implementing each.

On the Pi side, note the fixtures show Pi choosing `bash` to perform a file
edit rather than a dedicated edit tool. The tool vocabulary is not fixed, which
is the practical argument for D5's default tool card.

Streaming assembly: on `item/started` create the placeholder message; on each
delta append to the right content block; on `item/completed` replace with the
authoritative item text. Correlate by `itemId`. This state machine is the
thing D3 keeps server-side.

Fork: Codex `thread/fork` + `thread/rollback`; expose the same
`listForkPoints`/`fork` contract by reading thread items for the fork points.

## Spawning through sbox

The seam pipane proved: resolve the executable, then spawn. Per D7 the server
builds the command itself:

- Pi: `direnv exec <workspace> sbox -- pi --mode rpc [--model ...]` — sbox
  auto-detects the `pi` profile (mounts `~/.pi/agent`), workspace = git root
  of the spawn cwd.
- Codex: `direnv exec <workspace> sbox -- codex app-server` — sbox's `codex`
  profile mounts `~/.codex` rw (so the sqlite state runtime works) and injects
  `--sandbox danger-full-access` so Codex does not double-sandbox. The
  injection is keyed on the command name, so it applies to `codex` and not to
  the surrounding wrapper.
- **The server must spawn each subprocess with `cwd` = that session's
  workspace**, or sbox jails the wrong tree (or refuses if there is no git
  root), and `direnv` loads the wrong environment.

stdio crosses the bwrap boundary transparently (proven), so the adapter reads
the same pipes whether or not sbox is present.

## Testing strategy

- **Unit (bun test / vitest):** the adapters, especially the Codex
  `ThreadItem` → `AgentMessage` mapping — table-driven over the captured
  protocol fixtures in `resources/fixtures/`, which already cover streaming
  text, a tool call/result pair, and a file edit for both backends. Assert on
  *structure* (event sequence, item types, block kinds, id correlation), never
  on exact model wording. D3 is what makes this possible without a DOM.
- **Contract tests:** feed each adapter recorded protocol transcripts; assert
  the common `BackendAdapter` behavior is identical in shape across Pi and
  Codex.
- **Server:** SessionManager lifecycle (spawn/reap, subprocess outlives
  connection, reconnect→repaint), the snapshot/upsert protocol including a
  dropped `seq`, LF-only framing for Pi.
- **Client (vitest + @testing-library/svelte):** block dispatch, the tool
  renderer registry and its fallback, markdown sanitization.
- **E2E (Playwright):** a mock-LLM or scripted agent driving a real turn end
  to end, screenshots for the rendering you care about.
- Keep protocol fixtures in the repo so tests do not require live model calls.

## Build order

1. **Pi-only vertical slice**: one session, streaming text, one real tool
   renderer, end to end through sbox. This proves the transport, the
   snapshot/upsert protocol, and the render loop while the backend is the
   identity mapping and cannot be the thing that is broken.
2. **Codex adapter** against recorded fixtures, offline. The mapping is the
   only genuine engineering here and deserves to land against a UI that
   already works and a harness that needs no live model.
3. Multi-session, fork UI, model selection.

## Remaining open questions

- Whether to import `resources/codex-protocol/` into `src/` or reference it in
  place. Either way it stays the source of truth; do not hand-write Codex
  types.
- Whether sbox's injected `--sandbox danger-full-access` suppresses Codex's
  approval `ServerRequest`s entirely (D2a).
- Whether `plan` and `contextCompaction` items deserve bespoke rendering or
  fold into text.
- Whether session listing needs an index cache once the corpus is larger than
  the ~973 sessions measured for D9. Both upstreams eventually built one.
