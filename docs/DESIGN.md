# Design

agentpane is a local web UI for coding agents. This document describes the
intended shape and the reasoning behind it. It is intent, not orders: where it
names a specific file or type, that is verified ground truth (see
`HANDOFF.md`); where it describes structure, prefer clarity and good factoring
over literal adherence.

## Goals

- One clean web UI that renders coding-agent conversations well: streaming
  text, thinking, tool calls, diffs, images, token/cost — reusing the
  maintained `pi-web-ui` component library so we do not rebuild rendering.
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
- Not a general chat client; the backends are coding agents with a workspace.

## Architecture

```
Browser (SPA, Lit + pi-web-ui)
   │  HTTP:      static bundle + control/query routes
   │  WebSocket: prompt / abort / fork  ↕  normalized event stream
   ▼
One server process (Bun/Node)
   ├── SessionManager:  sessionId → { child: sbox subprocess, adapter }
   │      • spawn on session open (cwd = that session's workspace)
   │      • subprocess lives as long as the server, NOT the WebSocket
   │      • kill on explicit close / server shutdown
   ├── Backend adapter (per session):  Pi | Codex
   │      • owns the child's stdio
   │      • translates protocol ⇄ the common contract below
   └── serves the SPA + WS on one port
        │  (stdio pipes, sbox-transparent)
        ▼
   sbox-wrapped agent:  `sbox pi --mode rpc`  |  `sbox codex app-server`
        • own creds mounted (sbox pi/codex profiles), workspace writable
```

### Why the subprocess outlives the connection

A browser refresh drops the WebSocket but must not kill the agent. On
reconnect the server re-serves the transcript so the UI repaints. This is a
*repaint* concern, not a lifecycle one — keep transcript state server-side (or
re-query the agent: Pi `get_entries`/`get_tree`, Codex `thread/read`). The
subprocess's lifetime is tied to the server process only.

### Language: TypeScript (Bun or Node)

Pi and Codex are both TS-native ecosystems; we can import Pi's message types
and Codex's generated bindings directly, and `pi-web-ui` is a browser
component library. Python (omnigent's choice) would buy nothing here and lose
the shared types. pipane's stack — Lit + Vite + Express + `ws` — is a proven
baseline; Bun is a reasonable modern alternative for the server.

## The backend adapter contract

The core abstraction. Each backend implements one interface; the server and UI
know only this interface. The rendering contract is fixed by `pi-web-ui`:
`MessageList` consumes `AgentMessage[]` (from `@earendil-works/pi-agent-core`).
So **every adapter's job is to produce and maintain an `AgentMessage[]` and a
streaming signal**, plus lifecycle controls.

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

  // state for the UI (the pi-web-ui render contract)
  getMessages(): AgentMessage[];
  onUpdate(cb: (state: { messages: AgentMessage[]; isStreaming: boolean }) => void): Unsubscribe;

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
the UI wants Pi's *message* model. Both carry the same information.

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
| `commandExecution` | `AssistantMessage` `{type:"toolCall"}` + `ToolResultMessage` | command + streamed output → tool call/result pair; use `registerToolRenderer` for nice display |
| `fileChange` | `toolCall` + `toolResult` (diff) | render as a patch/diff tool |
| `mcpToolCall`, `dynamicToolCall`, `webSearch` | `toolCall` + `toolResult` | generic tool mapping |
| `plan` | assistant text or a custom renderer | optional polish |
| `contextCompaction` | compaction summary message | Pi has a compaction message type; mirror it |

Content-block mapping (Codex `ContentItem` → Pi content):
`input_text`/`output_text` → `TextContent`; `input_image` → `ImageContent`.

Streaming assembly: on `item/started` create the placeholder message; on each
delta append to the right content block; on `item/completed` replace with the
authoritative item text. Correlate by `itemId`.

Where a Codex item has no clean Pi equivalent, prefer a **custom renderer**
(`registerMessageRenderer` / `registerToolRenderer`) over inventing a message
type — pipane does exactly this for its Pi-specific bits.

Fork: Codex `thread/fork` + `thread/rollback`; expose the same
`listForkPoints`/`fork` contract by reading thread items for the fork points.

## Spawning through sbox

The seam pipane proved: resolve the executable, then spawn. Instead of `pi`
directly, spawn `sbox` (or a `sandboxed-<agent>` wrapper):

- Pi: `sbox pi --mode rpc [--model ...]` — sbox auto-detects the `pi` profile
  (mounts `~/.pi/agent`), workspace = git root of the spawn cwd.
- Codex: `sbox codex app-server` — sbox `codex` profile mounts `~/.codex` rw
  (so the sqlite state runtime works) and injects `--sandbox
  danger-full-access` so Codex does not double-sandbox.
- Preserve the `direnv exec "$(pwd)"` step (per `sandboxed-pi`) so each
  session's workspace env/credentials load before the jail.
- **The server must spawn each subprocess with `cwd` = that session's
  workspace**, or sbox jails the wrong tree (or refuses if there is no git
  root).

stdio crosses the bwrap boundary transparently (proven), so the adapter reads
the same pipes whether or not sbox is present.

## Testing strategy

You asked for well-tested. Mirror pipane's layered approach:

- **Unit (vitest):** the adapters, especially the Codex `ThreadItem` →
  `AgentMessage` mapping — table-driven over captured protocol fixtures.
  Capture real event logs (extend the probes) and assert the produced
  `AgentMessage[]`.
- **Contract tests:** feed each adapter recorded protocol transcripts; assert
  the common `BackendAdapter` behavior is identical in shape across Pi and
  Codex.
- **Server:** SessionManager lifecycle (spawn/reap, subprocess outlives
  connection, reconnect→repaint), WS bridge framing (LF-only for Pi).
- **E2E (Playwright, like pipane):** a mock-LLM or scripted agent driving a
  real turn end to end, screenshots for the rendering you care about.
- Keep protocol fixtures in the repo so tests do not require live model calls.

## Open questions to resolve during build

- Bun vs Node for the server (both viable; Bun is leaner, Node matches pipane).
- Whether to import `resources/codex-protocol/` into `src/` or reference it.
- Exact reconnect/repaint mechanism (server-side transcript cache vs.
  re-query) — pick per how `pi-web-ui` wants to be re-seeded.
- How `pi-web-ui`'s `ChatPanel` (which wants an `Agent` object) relates to
  driving it via `MessageList` + our adapter — inspect the 0.75 API before
  committing to `ChatPanel` vs. composing `MessageList` directly.
