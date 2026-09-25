# Design

agentpane is a local web UI for coding agents.
This document describes the intended shape and the reasoning behind it.
It is intent, not orders: where it names a specific file or type, that is verified ground truth (see `HANDOFF.md`); where it describes structure, prefer clarity and good factoring over literal adherence.

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
  See D5 — this reverses the original plan, and the evidence is in `HANDOFF.md`.
- **Not** remotely accessible.
  Loopback only; see D8.
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
   ├── SessionIndex:    walks the Pi, Codex, and Claude Code session stores
   │      • metadata only (id, cwd, timestamp, preview) — no process
   ├── SessionManager:  {backend, id} → { child: sbox subprocess, adapter }
   │      • spawn on attach (cwd = that session's workspace), not on list
   │      • subprocess outlives the connection; reaped on shutdown (idle / LRU per D12 is decided, not built)
   │      • never killed by a dropped browser connection
   ├── Backend adapter (per session):  Pi | Codex | Claude Code
   │      • owns the child's stdio
   │      • owns the transcript: maintains AgentMessage[] + isStreaming
   └── serves the SPA + SSE + REST on one loopback port
        │  (stdio pipes, sbox-transparent)
        ▼
   sbox-wrapped agent:  `sbox pi --mode rpc` | `sbox codex app-server` | `sbox claude -p ...`
        • own creds mounted by the matching sbox profile, workspace writable
```

### Why the subprocess outlives the connection

A browser refresh drops the event stream but must not kill the agent.
A subprocess's lifetime is decoupled from any connection: the server, not the client, decides when it dies.
Because the server owns the transcript (D3), reconnect is a *repaint*, not a lifecycle event — the client re-subscribes and receives a fresh snapshot.

The subprocess is *not*, however, meant to be tied to the server's whole lifetime: D12 bounds it by idleness and by a count cap, reclaimed automatically, and supersedes the original "lives as long as the server" rule.
D12 is decided but not yet built (OW-33, OW-34, OW-35); today only shutdown reaps.

## Decisions

Each of these was open in the first draft and is now settled.
The reasoning matters more than the conclusion: if a premise turns out to be wrong, revisit.

### D1. Runtime: Bun

Pi and Codex are both TS-native, so we import Pi's message types and Codex's generated bindings directly.
Bun is leaner than Node and its bundled test runner and HTTP server reduce moving parts for a single-user local app.
Nothing in the design depends on Bun specifically.

### D2. Transport: SSE + REST, not WebSocket

The server is authoritative (D3), so client→server traffic is low-volume and command-shaped rather than RPC-heavy — the regime where SSE is comfortable.

- `EventSource` reconnects natively; under D3 recovery is just "re-snapshot", so we write no backoff/retry state at all.
- Everything non-streaming is a plain route (list sessions, list models, get fork points, set model), which is curl-able and individually visible in the Network tab. pipane pushed these through its WebSocket as RPC only because it already had the socket open.

Costs, accepted knowingly:

- **Ordering is not guaranteed across the two channels.**
  A POSTed prompt can produce SSE events before the POST response returns.
  Harmless under D3, but write code that assumes it.
- **Use one multiplexed stream**, with a session id on each event.
  Browsers cap ~6 connections per origin on HTTP/1.1 and an open `EventSource` holds one permanently, so a stream per session would wall at six.
- Server-initiated requests need correlation glue; see D2a.

If the client ever becomes chatty and needs constantly correlated replies, this is the decision to revisit — a single WebSocket would then be tidier.

One thing building the transport added to the event union, because it is not optional and prose would not have survived the gap between the two halves: **`renamed`**.
A session's id changes under the client during normal use — every backend replaces a `virtual` session's minted id with its own at attach, and the first prompt may move it again (D9) — so the id the browser created a session with is not the id it keeps.
The server keeps honouring the old id on REST routes indefinitely, but every event after the change carries the new one, so a client that ignores `renamed` renders a live session into a transcript nothing updates.
See D9's "Three states".
D24 retires this event: once both clients key a live session by the handle the server mints, an id change is an attribute carried on the next event under that handle, and the arm leaves the union with OW-mofuho.

### D2a. Server-initiated requests

Codex's `ServerRequest` (`resources/codex-protocol/ServerRequest.ts`) is a request *from* the agent *to* the client, carrying a `RequestId`: approval requests, `item/tool/requestUserInput`, MCP elicitation, dynamic tool call.
The agent blocks until answered.

The adapter answers what it can itself.
What genuinely needs a human goes to the browser over SSE with its id and comes back via a REST reply route; the adapter matches it up and responds to Codex.

**And when the browser cannot answer either, the adapter declines rather than holding it.**
Decided 2026-09-11 (OW-yikoyo).
The sentence above assumed the browser is a place a request can be answered, and today it is not: the whole of agentpane's response to a pending request is a warning line, because OW-bijera's client half does not exist.
So a request nothing can answer was being held until the user killed the session, and the user was told that killing it was the remedy.
A turn that carries on from a "no" it can read beats a session that has to be destroyed, and the model can try something else -- which is the case for declining rather than erroring where a decline shape exists, since a JSON-RPC error reads as a broken client rather than a refusal.
The user is told what arrived in both cases; silently refusing on the agent's behalf is the one outcome ruled out.
The Codex adapter does this since OW-zisumi: a kind with an entry in `DECLINE_RESPONSES` (`src/server/adapters/codex/protocol.ts`) is published as before, then declined at once through the adapter's own `reply(id, null)`, retracted through `onRequestResolved`, and named in a session error; a kind with no entry is errored out at arrival and never published (OW-nujawi).
The decline binds Pi's dialog requests too, and the Pi adapter does the same since OW-yosuzo: an `extension_ui_request` carrying one of `PI_DIALOG_METHODS` (`select`, `confirm`, `input`, `editor`; `src/server/adapters/pi/protocol.ts`) is published as before, then cancelled at once through the adapter's own `reply(id, null)` -- an `extension_ui_response` with `cancelled: true`, the one refusal Pi's dialogs have -- retracted through `onRequestResolved`, and named in a session error.
Pi's fire-and-forget methods expect no reply and are never published, so nothing declines them.

This is provisional and OW-bijera is what revisits it: once a human can answer, holding becomes the right behaviour again for the kinds they can answer.
It is therefore sequenced *before* bijera rather than after, because declining honestly needs a retraction, which this contract lacked until OW-gusifo -- see the paragraph below.
The decline goes through `reply` after publishing, rather than replacing the publish, so that the request namespace, the typed reverse mapping and wire-id scoping stay on the live path: what bijera removes is the decline, not machinery it would have to rebuild.

**A request that stops being pending is retracted on the wire, closing what was a gap and never a decision (OW-gusifo).**
Until then `ServerEvent` carried `request` and nothing that retracted it.
Since OW-bipume the server holds each session's pending requests and every `snapshot` carries them, so a request answered through agentpane's reply route left clients' views only at the next snapshot, and one Codex reported resolved left nothing at all: the adapter dropped it, the server went on holding it, and every snapshot re-sent it.
Now a `request-resolved` event carrying the `requestId` retracts a request however it stopped being pending: `SessionManager.clearRequest` broadcasts it after the reply route answers, and does the same for an adapter's `onRequestResolved`, which the Codex adapter fires on `serverRequest/resolved` for a request `reply` had not answered, and on its own decline at arrival (OW-zisumi), and which the Pi adapter fires on its own cancel of a dialog at arrival (OW-yosuzo).
Until OW-bijera the first finds nothing to act on, since every request the Codex adapter publishes is answered before the next line is read.
Both clients drop the request on it -- the browser from `view.requests` (`src/client/session-state.ts`), Emacs its warning line through the helper's `session/requestResolved` -- and a client that missed it converges on the next snapshot, whose `requests` no longer hold it.
A subagent thread's request is routed to its parent's adapter (OW-futewo) while its `serverRequest/resolved` names the child's thread, so the Codex reducer reads that notification ahead of its thread guard and lets the wire id, which only the adapter that published the request maps, decide who acts on it.
What makes Codex resolve a request without agentpane's answer is unmeasured: auto-approval or another client of the app-server was assumed, but the only `serverRequest/resolved` captured, in `resources/fixtures/codex/tool-edit.jsonl` (`codex-cli 0.147.0`), followed the capture harness's own answer.

**These requests are real, not theoretical.**
The `tool-edit` fixture in `resources/fixtures/codex/` contains a live `item/fileChange/requestApproval`, answered by the capture harness, followed by `serverRequest/resolved`.
An unanswered one hangs the turn.

What the OW-18 run showed (`docs/MANUAL_TESTING.md`): a live edit-provoking prompt on a `danger-full-access` thread raised no approval `ServerRequest` under either `on-request` or `never`, and the same prompt on a `read-only` thread raised one `item/fileChange/requestApproval` under `on-request` and none under `never`.
So `approvalPolicy: "never"` demonstrably suppresses that request where one would otherwise arise, and on a `danger-full-access` thread none arises to suppress — the sandbox grants the write and `on-request` has nothing to ask about.
Those are different facts, and only the `read-only` pair is a suppression result.
`item/fileChange/requestApproval` is the only approval kind any cell provoked; the command-execution and permissions approvals were not measured.
Note the older framing here — that sbox's injected `--sandbox danger-full-access` governs this — was wrong: that CLI flag is a no-op for `app-server` (OW-37), and the effective levers are the per-thread sandbox and approval policies, both of which the adapter now sets (D7a).
`requestUserInput` and MCP elicitation are separate from the approvals and have not been shown to be suppressed by either lever; the attempts to provoke a `requestUserInput` are recorded with the OW-18 run and did not fire, so they still need a path to the human.

### D3. State protocol: server-authoritative snapshot + tail upsert

The adapter owns the child's stdio, so it necessarily holds the assembled `AgentMessage[]` already.
The only real question was what crosses the wire: assembled state, or raw events the client re-reduces.

Assembled state, because the Codex item→message mapping is **stateful** (placeholder on `item/started`, deltas correlated by `itemId`, authoritative replace on `item/completed`).
Sending raw events would split the core abstraction across the wire and put its backend-specific half in the browser.
Server-side it stays in one place, unit-testable against fixtures with no DOM.
It also makes multi-tab and mid-turn reconnect correct for free.

The wire is loopback, so **no delta protocol** — full snapshot on attach and on every reconnect.
What loopback does *not* make free is serialization CPU: re-serializing the whole transcript per token is quadratic over a turn.
But streaming only ever touches the tail, and completed messages are immutable, so:

- snapshot on attach, reconnect, and session switch
- `{seq, index, message}` upsert during a turn — O(1) per token
- a monotonic `seq` detects a dropped update; recovery is "re-snapshot"

This is strictly less machinery than pipane's SHA-256-verified delta sync, which existed to survive a real network.

Re-querying the agent (Pi `get_messages`, Codex `thread/turns/list`, Claude Code's own store file) remains the **cold-start** path — server restarted, or attaching to a session that predates it.
That is not an alternative to the above; it is how the server populates a transcript it does not yet have.

### D4. Client framework: Svelte 5

The client is one long list where exactly one item mutates rapidly.
Svelte's compiled fine-grained updates suit that with no virtual-DOM diff over a long transcript and no memoization discipline to get wrong.
Scoped styles are built in, which matters because we are hand-rolling the look, and the runtime is small.

Lit is the credible runner-up (it would make pipane directly readable as a model).
The original reason to prefer Lit — consuming `pi-web-ui` components — disappeared with D5, and Svelte can consume a custom element anyway if we ever want one.

Note Svelte 5's runes differ substantially from Svelte 4.

### D5. Rendering: our own components, dispatching on content blocks

This reverses the first draft, which assumed `pi-web-ui` would save us from rebuilding rendering.
Investigation showed otherwise (evidence in `HANDOFF`):

- It ships **four** tool renderers — Bash, Calculate, GetCurrentTime, and a default.
  **None** for coding tools. pipane wrote 663 lines of its own.
- `renderMessage` statically pulls `pdfjs-dist`, `xlsx`, `docx-preview`, and `jszip` through a side-effect import chain, and neither package declares `sideEffects: false`, so it cannot be shaken out.
  `xlsx` also resolves from a CDN tarball URL rather than the npm registry.
- It has no fallback tool renderer — the hook pipane had to patch in.
  Codex emits `mcpToolCall` and `dynamicToolCall` with arbitrary names that cannot be pre-registered, so we need one.
- Its markdown (via mini-lit) escapes HTML with regexes over the *source*, then renders through `unsafeHTML` with no sanitizer on the output.

Structure — dispatch on **content blocks**, not on messages.
An `AssistantMessage.content` is an array of `text` / `thinking` / `toolCall` / `image` blocks, which is both the real rendering unit and what Codex's items map onto:

```
Transcript   keyed each over messages
  Message    role chrome — user / assistant / tool-result
    Block    dispatch on block.type
      Markdown · Thinking · ToolCall · Image
        ToolCall → registry lookup by tool name, default card if unknown
```

The registry is a `Map<string, Component>` with a default entry — the missing fallback hook, in about five lines, owned by us.

Dependencies, four: `marked`, `highlight.js`, `dompurify`, `diff`.
DOMPurify is not optional: the primary use case is rendering the contents of repositories we do not control into a page that holds a channel to an API that spawns processes.
Sanitize the parsed output.
Prefer `shiki` over `highlight.js` only once streaming is settled — it is async, which complicates token-by-token rendering.

**Remote media does not load automatically (2026-09-09, OW-holabo).**
Sanitizing the output stops script, and it was never meant to stop a fetch.
`![](https://host/x.png)` in assistant text or a tool result rendered an `<img>` that requested that URL the moment the transcript was opened, handing the host the reader's IP address and the time they read it.
That is not XSS — DOMPurify strips `onerror` and every script vector, and did here — but it is a channel out of a page whose whole stated purpose is "rendering the contents of repositories we do not control", and the author of a hostile repository chooses the host.

So remote media renders as a link the reader clicks, not as media that loads.
The information survives, the automatic request does not.
`data:` sources keep rendering as images: they carry their own bytes and have no network side.

The vector list is wider than markdown image syntax, which is why this is enforced in `sanitize()` rather than in a marked renderer override.
Raw `<img>` written as HTML, `img srcset`, `<video src>` and its `poster`, `<audio src>`, `<picture><source srcset>`, and a protocol-relative `//host/x.png` all reached the page before this change; `<input type=image>` did not, because `input` is already forbidden.
Enumerating that list is exactly why it should not be the only defence: it is only as good as whoever last thought about it.
The browser-enforced half — a `Content-Security-Policy` restricting `img-src` and `media-src`, which agentpane does not serve at all today — is OW-kigole.
The two overlap deliberately: the header is the boundary, and the renderer is the only place that can turn a blocked image into something a reader can click.

Loopback-only (D8) does not answer this. D8 bounds who can reach the server; it says nothing about where the page can send a request once hostile content is inside it.

Known hot spot: re-parsing markdown per token on a long message.
Only the tail block changes; re-parse just that block and throttle to a frame.
What confines it to the tail block is `App.svelte`'s `view` being `$state.raw` (OW-detepa) — an unchanged block's `text` prop then reads `===` and its effect is not re-run.
Under a deep `$state` it did not hold, because `text={block.text}` creates no derived boundary and effects do not value-compare.

On looks: nothing in a dependency confers taste.
Define a type scale, a spacing scale, and semantic color as CSS custom properties early; collapse tool cards by default behind a one-line summary; keep thinking blocks visually recessive.
Plain scoped CSS over Tailwind — Tailwind's payoff scales with team size and surface area, and this is a dozen components.

### D6. Internal contract: `AgentMessage`

Keep `AgentMessage` (from `@earendil-works/pi-agent-core`) as the internal and wire shape even though we no longer use `pi-web-ui`.
Pi hands it to us for free, which makes the Pi adapter nearly an identity mapping; it is well-typed; and the Codex mapping work is required whatever shape we pick, so inventing a neutral one buys little and loses the Pi freebie.

### D7. Sandbox spawn: the server does it, no wrapper scripts

The server spawns `direnv exec <workspace> sbox -- <agent> ...` directly.
One seam, no PATH dependency, testable.
`~/.local/bin/sandboxed-pi` exists for pipane specifically and is not used here.

### D7a. Codex approval policy: `never`, set by the adapter

agentpane sets `approvalPolicy: "never"` on every Codex thread it creates, rather than inheriting Codex's `on-request` default.
The intent is to avoid permission prompts, not to route them into agentpane's UI: agentpane has no approval dialog, so an approval `ServerRequest` is refused at arrival -- declined where it has a decline shape, errored out otherwise -- and named in a session error (D2a).
When this was decided the trade was "no dialog" against "a hung turn", and the hung turn is worse; since OW-zisumi what `on-request` would cost instead is an approval refused at arrival.

The site is `CodexAdapterOptions.approvalPolicy` in `src/server/adapters/codex/adapter.ts`, beside `sandbox`, applied at thread creation exactly the way `sandbox` is.
Not sbox: sbox injects its flags before the subcommand (`codex --sandbox danger-full-access app-server`), and a CLI approval flag there would be the same no-op the sandbox flag already is for `app-server` (OW-37).
Not `~/.codex/config.toml`: the `-c approval_policy=never` route `app-server` does accept would put a hidden global outside the repo, contradicting an adapter option that sets the sibling policy and invisible to `bun run check`.

Both policies go on **all three** thread-creation paths — `thread/start`, `thread/resume`, and `thread/fork`.
`thread/fork` is not symmetry for its own sake.
The OW-18 run found that a fork inherits the parent's `approvalPolicy` but **not** its `sandbox`: forking a `dangerFullAccess` parent with only `threadId` and `cwd` returned a thread reporting `workspaceWrite`.
The copied `~/.codex/config.toml` sets no sandbox key, so that value is app-server's own default rather than the operator's configuration; the probe records the config's key names for exactly that reason.
Passing both explicitly repairs that downgrade.

What the policy buys today is insurance rather than a behaviour change: under the `danger-full-access` sandbox agentpane already uses, no approval arrived under either policy, so `never` was not shown to be doing work today and bites only if that sandbox setting ever narrows.
Where it did bite — a `read-only` thread — the suppression is not a silent grant: that cell ended with `notes.txt` unchanged and no `fileChange` item completed, while the assistant's text claimed the edit was made.
The run did not establish whether the tool call was refused or never issued, and did not read the turn's final `status`.

### D8. Loopback only

Bind `127.0.0.1` explicitly.
No auth token, no cookie, no localhost-bypass layer — none of which needs to exist once remote access is off the table. (pipane binds all interfaces on purpose and gates it with a token; that is a different product decision.)

**Closing the network is not closing the browser**, and the original wording above conflated them.
Any page in any tab can issue a cross-origin request to a loopback port, and a `POST` with a simple content type is not preflighted — so `evil.com` cannot *read* our replies, but it can drive them, and every route behind `/api` spawns sandboxed agents with write access to the user's repositories.
The transport therefore rejects any `/api` request carrying a non-loopback `Origin`, and rejects a request whose `Sec-Fetch-Site` is present but is neither `same-origin` nor `none`.

Note the rule is loopback-*origin*, not same-origin: in dev the page is served by Vite on another port and proxied here (`changeOrigin: false`), so an exact match would reject the only client we have.
The OW-fumegi browser reproduction showed that cross-site no-CORS GETs can omit `Origin` while the browser still sends `Sec-Fetch-Site`; curl and other non-browser clients may omit both headers, so header absence remains allowed.
The production client and the development client through Vite's proxy are same-origin and therefore pass the request-metadata guard.
This is still not auth, and it is not meant to be; it is the missing half of "not remotely accessible". pipane has no equivalent (HANDOFF finding 17).

### D9. Sessions: enumerate from the filesystem, spawn only on attach

The requirement is pipane's: see every existing session in every workspace, create a new one in an existing or new workspace, and switch between recent sessions quickly.

**Every backend stores sessions as JSONL on disk, and all are enumerable with nothing running** (Claude Code's `~/.claude/projects/<munged-cwd>/<uuid>.jsonl` store joined via OW-votasi).
Measured on the work laptop for the original two:

| | Location | Header line | Files | Walk | Read line 1 |
|---|---|---|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `{"type":"session_meta","payload":{id,cwd,timestamp,model_provider,…}}` | 583 | 0.00s | 0.18s |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `{"type":"session",…,cwd}` | 390 | 0.01s | 0.09s |

973 sessions across 28 workspaces in ~0.3s (Python).
So:

- **No catalog process.**
  An earlier draft of this decision had the server keep a workspace-less `codex app-server` alive purely to answer `thread/list`.
  That is unnecessary — and it would have run into sbox wanting a workspace to jail to.
- **No index cache initially.** pipane caches its Pi index at `~/.pi/agent/cache/`, and Codex's `thread/list` has a `useStateDbOnly` escape hatch, so both upstreams evidently found listing slow at some point.
  Our numbers do not justify a cache yet.
  Leave room for one; do not build it.
- **Tolerate header drift.** 5 of 583 Codex files use an older bare `{id,timestamp}` header with no `cwd`.
  Bucket those as unknown-workspace rather than failing the walk.
  Expect more drift over time — the walk should never throw on a file it does not recognise.

**Three states**, from pipane, which is what makes listing everything cheap:

- `virtual` — workspace chosen, nothing on disk yet.
  It stays `virtual` until its first prompt (pipane uses a `__new__` sentinel), so browsing never litters the backend's store with empty sessions.
- `detached` — exists on disk, no subprocess.
- `attached` — live subprocess.

**A `virtual` session's id and its store file arrive at different times**, and neither is the first prompt everywhere.
The server mints a `virtual:` id at creation, and every backend replaces it at attach:

- Pi reports its session file's path from `start()`'s `get_state`, as of `pi 0.84.1` (`docs/HANDOFF.md` finding 41), `pi 0.85.1` and `pi 0.87.1` (`docs/MANUAL_TESTING.md`, OW-jamoyi and OW-bohodu).
- Codex's `thread/start` names the thread, as of `codex-cli 0.156.0` (`docs/MANUAL_TESTING.md`, OW-hojefo).
- Claude Code's id is the uuid the adapter mints for `--session-id`, so it is known before the process exists.

What reaches disk waits for the first turn on all three.
As of `claude 2.1.280`, the store file appeared 0.3 s after the first user message was written and not in 15 s before it; as of `pi 0.87.1`, the path `get_state` named held no file until the first turn's reply had ended; as of `codex-cli 0.156.0`, no rollout existed until the first turn, and `thread/resume` of a thread with none was refused.
On Claude Code and Pi a process closed before its first prompt left nothing behind (`docs/MANUAL_TESTING.md`, OW-bohodu).
Finding 41 read Pi 0.84.1's file as already on disk at start, but its evidence was the rename, which shows only the name.

So an id without the `virtual:` prefix does not mean anything is on disk.
The server tracks the `virtual` state apart from the id (`ManagedSession.virtual`, cleared by `markPrompted`), and while it is set nothing is on disk, but its clearing does not mean a file exists either.
It clears as the first prompt is sent, before any backend above has written, and a fork's container starts with it clear and no file behind it (OW-japuzo, OW-hojefo).
What says a file exists is the session index: `SessionSummary.onDisk` is true once the index has listed the session, and the manager remembers that for the attach response, which does not walk the index (OW-wedupe).
The first prompt can still move the id on Pi: `PiAdapter` probes `get_state` again after its first `submit()`.
That probe has not fired on the Pi versions above, since `start()` already resolved the id, and it stays, because a backend that has named nothing by the end of attach is exactly what `virtual` describes.
`ClaudeAdapter` also adopts whatever `session_id` a turn's `init` names, for a different reason -- the CLI is authoritative about its own store -- and `init` arrives after `submit()` has settled.
The manager hears of every such move as it happens: each adapter announces its id change through `onRefChanged` and the manager re-keys on it (D24, OW-nikogo), where it once re-read `ref` at three points and missed the `init` altogether (OW-hikefi).
A live session keyed by a handle the server mints, with the backend's ids as names on its container, is the rest of what D24 decides (OW-suyinu).

**Spawn only on attach.**
The list needs metadata only — id, cwd, timestamp, and a preview — all cheap to read from the file.
A session becomes `attached` when the user prompts it or opens its transcript.

Two corrections from building this, both verified:

- **The Codex layout is not uniformly `YYYY/MM/DD/`.**
  Three files on the work laptop sit flat at `~/.codex/sessions/` with no date nesting (580 are nested).
  Walk to arbitrary depth; do not pattern-match the path.
- **"Preview = first user message" is wrong for Codex.**
  In a 20-session sample, only *one* had genuine human text as its first user-role block.
  The rest open with harness-injected content — AGENTS.md dumps, `<environment_context>`, `<user_instructions>`, plugin and skill boilerplate — so a literal implementation shows a system-prompt dump as the preview nearly every time.
  The real message is typically the 2nd or 3rd user-role turn.
  Skipping known synthetic wrappers is a heuristic, not a clean rule, and it will need maintenance as injected content drifts.
  Pi has no such problem: its first user message is the human's text.

Deliberately *not* doing: parsing the on-disk JSONL into `AgentMessage[]` to display a detached transcript without spawning.
It would avoid a subprocess, but it means a second, format-dependent mapping per backend, kept in sync with a format we have already watched drift.
One protocol→`AgentMessage` mapping per backend is the point of the adapter contract.
Transcripts come from `thread/turns/list` / `get_entries` on an attached session; since subprocesses outlive connections, switching back to a recent session is instant anyway.

**Session identity is backend-qualified**: `{backend, id}` (`BackendId`).
Pi's id is its JSONL path; Codex's is a UUIDv7 thread id; Claude Code's is the session uuid its store file is named after.
A listed session inherently belongs to whichever store it was found in.

**REST surface** that follows: `GET /api/sessions` returns the merged list across every backend, sorted by recency, with an optional `cwd` filter (so workspace-first browsing is the same query pre-filtered); `POST /api/sessions` creates a `virtual` session from a workspace + backend + model.

Codex additionally offers `thread/list` over the protocol, with pagination, sorting, and `cwd`/`archived`/`searchTerm` filters.
We do not need it for enumeration, but it is the better source for anything requiring Codex's own metadata (archived state, sections, names) on an already-attached session.

### D10. Pi types: dev-dependency, type-only imports

D6 keeps `AgentMessage` as the internal contract, which means depending on `@earendil-works/pi-agent-core` and `pi-ai` — runtime packages we want none of the runtime from.

Take them as **devDependencies** and import with `import type` only.
TypeScript erases type-only imports, so nothing reaches the bundle.
Pin the versions.

`verbatimModuleSyntax: true` is set, but be clear about what it does: it makes type-only imports *explicit*, so their erasure is predictable.
It does **not** stop a value import from a devDependency — verified against tsc, which accepts `import { Agent } from "@earendil-works/pi-agent-core"` without complaint and would happily ship the runtime into the browser bundle.
The enforcement is a test, `src/import-boundaries.test.ts`, which fails with the offending file and import line.
Add a package to `TYPE_ONLY_PACKAGES` there if this list grows.

The alternative — vendoring the `.d.ts` files into `src/` — trades drift surprise for manual sync, and loses the property that makes D6 worth having: that Pi's own shape is what we conform to.

### D11. The wire contract is a shared module

Both ends of D2/D3 are ours, so the SSE event union and the REST request/response types live in one module under `src/shared/` and are imported by server and client alike.
Snapshot, upsert, and server-request events are a discriminated union on a `type` field with the `seq` and session id at the top level.

This is the one place worth being concrete rather than leaving to implementation judgement: the two halves are written at different times and will drift if the contract is only described in prose.
D24 adds a `handle` to `SessionSummary` and, beside `session`, to every per-session event and to the helper's notifications (OW-suyinu), and retires `renamed` once both clients read it (OW-mofuho).

### D12. Bounded subprocess lifetime: idle timeout + LRU cap

**Decided on 2026-08-15, not yet built, and deliberately so.**
The reaper is OW-33, the cap OW-34, and the transparent re-attach that makes eviction invisible OW-35; the prose below is written as the design reads once they land.

Those three are open and are not a fire.
The pressure this decision relieves does not arise yet: agentpane is still changed several times a day, and each restart reclaims every subprocess, so attached sessions never pile up far enough for an idle timer or a cap to have anything to do.
The owner said so when D12 was taken and again on 2026-09-11, and the second time was a decision not to build it rather than an oversight.
Read the gap between this decision and the code as waiting on a condition, then — not as a spec nobody got to.
The condition is the restart cadence itself: when agentpane stops being restarted through the day, the sessions this bounds start accumulating and OW-33/34/35 become work.
Nothing measures that, so the signal is the owner noticing it.

The design below is not provisional and is not up for redesign in the meantime.
It is unbuilt, which is a different thing, and the reasoning behind each of its parts is what an implementer would otherwise have to rediscover.

The first draft tied a subprocess's life to the *server's*: killed only on an explicit close or on shutdown, never otherwise.
That does not bound resource use — a day of browsing leaves a sandboxed agent alive per session touched, each holding its workspace.
This decision reverses that: subprocesses are reclaimed automatically, on two triggers.
(This decision was originally read as refusing a by-hand detach control, because managing subprocess lifetime by hand is what it replaces.
The owner settled on 2026-09-16 that the two are not exclusive, and OW-tewave put a Detach item in the composer's Tools menu: the reaper clears a session's attached stripe fifteen minutes after its last activity, and Detach clears it when the user decides the conversation is done.
What that item is for is a truthful indicator, not reclamation — the stripe OW-lepoki draws claims a live agent for the life of the server process, and until Detach landed nothing took it down at all.
Detach starts from the exemption predicate below and departs from it twice: it drops the `virtual` exemption, which guards a session the *reaper* would remove out from under a user who just created it and has nothing to say about a deliberate click, and it adds a fourth condition D12 has no reason to carry — no prompt POST of this client's own in flight, since the turn such a POST starts is not streaming yet.
The `DELETE` route it calls was always going to stay: it is useful programmatically and shutdown-adjacent code leans on it.)

**Why this is safe at all.**
Eviction is not a new capability — it is the `attached → detached` transition D9 already defines, fired automatically instead of by hand.
The adapter's in-memory `AgentMessage[]` is lost on eviction, but D3/D9 already rehydrate a detached session from disk through each backend's resume path on the next attach.
So an evicted session is a *detached* session, not a lost one; the next attach re-spawns and re-hydrates transparently.
The "subprocess outlives the connection" invariant is untouched — it is now additionally *bounded*.

**Two triggers, one predicate:**

- **Idle timeout (15 min).**
  A per-session timer detaches a session that has seen no activity for the interval.
  Bounds *time*.
- **LRU cap (N=16).**
  Checked at attach, before spawning the 17th subprocess: evict the coldest eligible session, then spawn.
  Bounds *count*.

Both call the same `evict` = `dispose()` + flip to `detached`, keeping the summary in the list.
Both are gated by the same **exemption predicate** — the load-bearing part of this decision, because "idle" is not "safe to kill":

1. **Never evict a streaming turn** (`isStreaming`).
   This is what makes the LRU age of a session you are actively watching irrelevant — it cannot be reaped regardless.
2. **Never evict a session blocked on a pending request** (D2a).
   A Codex approval dialog is idle by token-flow but is holding a human hostage; killing it strands the turn.
3. **Never evict a `virtual`, unmaterialized session.**
   Before its first turn there is nothing on disk to rehydrate from, whatever id attach gave it (D9) — eviction would be data loss, not detach.

**Two clocks, not one**, because the triggers ask different questions:

- **LRU recency = last *attach*.**
  "Select a session" is client-only; the server hears it only as an `attach` call (`controller.select → api.attach`), and `attach` is idempotent — switching back to a live session re-enters `attach` and re-snapshots without respawning.
  So "which did I last select" *is* "which did I last attach," for free, with no new client→server signal.
- **Idle clock = last activity of any kind** — reset on attach, on submit, and on turn-end.
  A session you prompt, whose turn runs three minutes and then sits, should measure its 15 minutes from when the turn *ended*, not from the prompt or the attach.
  Submit feeds this clock; it does not touch LRU order (a just-prompted session is either streaming-exempt or already recent from its attach).

**All-busy is an immediate reject, not a wait.**
If all 16 are exempt when the 17th attach arrives, the attach fails with an at-capacity error rather than blocking.
This is deliberately visible: the condition should be rare (idle sessions are always evictable, so it bites only under 16 concurrent streaming-or-blocked turns), and a reject removes the ambiguity between "waiting for a turn to finish" and "just slow to attach."
Free one and retry.

**Bookkeeping constraint (load-bearing).**
The recency stamp lives **on the `ManagedSession` object**, never in a side map keyed by id.
Pi's id changes under us (`#adoptRef`, D9's `renamed`), and `#adoptRef` re-keys the same object while preserving its identity — so an on-object stamp follows the rename automatically, whereas an id-keyed side map would strand it under the old `virtual:` key.
The reaper must evict via the canonical ref (`#lookup` / `canonicalRef`) like everything else, or it reintroduces the exact double-spawn-on-stale-id bug that `#adoptRef` and the alias table exist to close.
D24 dissolves this constraint: a container keyed by a handle that never changes cannot be stranded by a rename, so a side map keyed by the handle is safe once OW-suyinu lands; until then it stands as written.

**Cost this shifts.**
Frequent eviction makes cold reattach the common path, which promoted OW-23 (`SessionIndex.get` walked both stores on every cold attach, ~0.28s) from a deferral to the hot path, and made fixing it a prerequisite to landing this rather than a follow-up.
**Now fixed:** `get` locates and parses exactly one file per lookup.
Note that a `cwd` filter would not have helped — `listSessions` applies it only after the walk+parse.

**Config.**
Single-user, no config file: `idleTimeoutMs` and `maxSessions` are named constants at the top of the manager module, not env or file.

### D13. Agentpane owns one small state file, and its marks are server state

**Decided, not yet built**: OW-66 carries it, and nothing under `src/server/` writes a file today.

Agentpane has never written anything of its own.
D9 enumerates sessions from the backends' stores, and every server-side fact is derived from a file some other program wrote.
This decision changes that, narrowly: a session can be marked **starred** or **hidden**, and the marks live in a file the server owns.

One three-state field per session -- normal, starred, hidden -- rather than two independent flags.
The combination the flags would buy is "starred and hidden", which is incoherent, and a single field forbids it by construction instead of leaving it representable and then policing it.

**Why the server rather than the browser.**
The rejected alternative was a per-viewer `localStorage` set, which is what OW-66 originally proposed and what D8 argues for: loopback only, one browser on one machine, so curation that travels between browsers is worth almost nothing.
What decides it instead is that a mark may need to **originate server-side**.
The server is what performs a fork, and a fork is exactly the operation that leaves behind a session the person may never want to see again; a browser-local store cannot express a mark the server sets, because some browser would have to be listening at the moment it happened.
Whether anything ever sets a mark automatically is deliberately not decided here -- but the store is placed where it *could* be.

**Config is not state**, and D12's "single-user, no config file, constants at the top of the manager module" still holds unchanged.
That rule is about values the developer chooses, which belong in code.
This file holds what the *user* authored, which cannot.

**Shape**, all of it deliberately small:

- `~/.agentpane/`, matching the backend state under `~/.pi`, `~/.codex`, and `~/.claude` that it already reads.
  It is per-user state, not per-checkout.
  The path is injectable, or every server test writes into a real home directory.
- One JSON object, `sessionKey(ref)` -> `"starred" | "hidden"`.
  Only marked sessions appear; normal is the absence of a record, so the file stays proportional to what you touched rather than to how many sessions exist.
- Written on every toggle -- the file is small and toggles are human-paced, so debouncing would be complexity with no case behind it -- via a temp file and `rename`.
  One process, one writer, loopback: no lock.
  (Pi, by contrast, takes a lock under `~/.pi/agent` merely to *read*.)
- Keyed by `sessionKey(ref)`, and **no mark on a `virtual` session**: D9's rename, at attach and possibly again at the first prompt, would strand a key placed before it.
- The server does not filter.
  `SessionSummary` carries the mark and the client decides what to draw, because a "show hidden" control needs the rows in hand either way and this leaves the route's meaning unchanged.

**A corrupt file is reported, not logged.**
If the file will not parse, it is renamed aside and the store starts empty -- keeping the evidence rather than eating it -- and the server *tells the browser*.
A log line on a headless server is indistinguishable from swallowing it, which this repo already has a name for (OW-15).
Reporting it needs a session-less `notice` arm on the `ServerEvent` union, since every error today carries a `session` ref and a per-session `seq` and this condition belongs to no session.
It lands with this feature rather than ahead of it, following the pattern the compaction work used for `compact()`, and it is small because `sessions-changed` is already a session-less, seq-less arm.
It will not stay single-use: a D12 reaper eviction and a spawn that fails before any session exists are both server-global and both currently unreportable.
The tag `notice` is no longer free for it: since OW-tujiya a per-session `notice` arm carries a backend's non-fatal warnings, so the session-less arm needs a tag of its own or a reason to share that one.

**Codex has slots of its own for both marks, and the decision stands anyway.**
As of `codex-cli 0.154.0` (home server, 2026-09-15), the `threads` table in `~/.codex/state_5.sqlite` carries `is_pinned` and `archived` columns, the protocol has `thread/archive` and `thread/unarchive` with matching notifications, and `thread/list` filters on archived state.
Pi and Claude Code have nothing equivalent, so a mark that lived in Codex's store would cover one backend of three; and D9's walk reads rollout files, which do not carry those columns, so even Codex's marks would be invisible to the list without a running app-server.
The file is the only place a mark can live uniformly, and this paragraph exists so that the next reader who finds `is_pinned` does not reopen the question.

**Names are not marks, and this file does not hold them.**
The owner decided on 2026-09-15 that a session name set in agentpane is written through to the backend and kept nowhere else: Pi's `set_session_name`, Claude Code's `rename_session` control request, and Codex's `thread/name/set` all accept a rename mid-session on an attached session, measured live that day (`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire").
The reasons are the ones this decision already weighs: no server-side copy to keep coherent, and agentpane stays one more UI over the underlying agent rather than a store beside it.
The cost accepted with it is that a detached session cannot be renamed, since there is no wire to write through; the owner does not want that, so the D13 file is not asked to carry a name it could.

### D14. Every affordance is reachable with a pointer; the keyboard types text

The owner's rule, stated on 2026-08-19: **nothing in this UI requires the keyboard except typing text into the composer.**
Keyboard paths are welcome alongside -- Escape to dismiss, Enter to send -- but never as the only way to reach a behaviour.

This is a constraint on what gets built rather than a rendering detail, which is why it is here and not inside the item that provoked it: it binds every UI item written from now on, and the next one should not have to rediscover it.

The default it exists to stop is not hypothetical.
OW-hezidi was filed with "whether cancel is a button or Escape" listed among the incidentals to decide in flight, which left it open that the only way out of an editing mode would be a key -- caught the same day, but filed that way first.
A pointer user who enters a mode and does not know the key is stuck in it, and that item's whole design rests on entering the mode being cheap and abandonable.
Escape as well is right; Escape only is the failure.

So: when an interaction introduces a mode, the control that leaves it is visible and clickable, and it is drawn where the mode announces itself rather than somewhere the user has to go looking.

This rule binds the browser client.
The Emacs client D22 chose is keyboard-first by the nature of its host, and a command reachable only by key is the ordinary shape of an Emacs mode, so it is not held to this; added 2026-09-22 under OW-vibipo, as OW-basoga had planned and OW-vibipo carried to either stream.

### D15. agentpane stops a streaming turn before forking it only where the backend abandons that turn anyway, which is Pi

Submitting an edit of an earlier message forks the session, and where a turn is streaming at that moment `forkAndSubmit` aborts it first — on Pi, and only there.
The owner took that abort uniformly across every backend on 2026-09-09, replacing the "first cut, safe on both" that OW-hezidi shipped it as.
The owner reframed it on 2026-09-13 (OW-ziyobe) and it is now Pi-only: the abort stands where the backend destroys the turn whatever agentpane does, and nowhere else.

This is not a window nobody enters.
Asked directly on 2026-09-11 whether the workflow ever involves scrolling back and editing while a turn is running, the owner said it absolutely does.

**Pi leaves no choice.**
A mid-stream fork there returns `success: true` and abandons the in-flight turn anyway — the active `sessionFile` moves, `isStreaming` goes false, and the turn settles (work laptop, 2026-08-20, `pi 0.84.2`; `docs/MANUAL_TESTING.md`, OW-yudoni).
That much has held on every run since, and it is the whole of what this decision turns on: agentpane cannot keep the turn alive across a Pi fork, so the only choice left is whether the user is told.
What the fork costs is now measured rather than inferred.
OW-sededi gave the probe's Pi cell the delta gate its Codex sibling had and re-ran it (home server, 2026-09-15, `pi 0.85.1` on `deepseek/deepseek-v4.1-flash`): with 47 `text_delta`s on the wire at the instant the fork request went out, the file the turn was streaming into held the reply's first 447 characters, not the empty assistant entry the ungated run before it had read (`docs/MANUAL_TESTING.md`, OW-sededi).
So the streamed prefix survives on the abandoned branch; what is lost is the rest of the reply and the branch it was on, and the earlier empty entry was a fork that landed before any text existed.
That makes the loss this decision warns about partial.
The abort does not cause that loss; it makes it deliberate and visible instead of silent, and the label is the only warning the user gets.

**The warning stays as it is, and says nothing about the surviving prefix.**
Put to the owner on 2026-09-15 with the measurement above (OW-lukaju), the alternative being to extend the edit banner's sentence to "... and keeps this one, with whatever the running turn had already written".
He chose to keep the sentence: he is agentpane's only user and knows what the fork costs, so copy bought nothing he needed.
That settles the framing question this passage used to leave open, buttons included: only the banner was ever on the table, because "Stop and fork" and "Stop and edit" name the consequence the user acts on and the banner is where this UI does its explaining (the docblock above it in `src/client/App.svelte` says so).
Two things the writer put in front of him that did not decide it, recorded because they are what to re-read if this reopens.
The banner's prose is pinned by no test, while both button strings are pinned in `src/client/App.test.ts` and "Stop and edit" again in `e2e/composer-shortcut.spec.ts` — so the cheap change was the one on offer, and a button rewrite would not have been.
And the surviving prefix sits in the pre-fork session, which `list()` does keep (OW-kekoji), but whose row carries the same preview label, backend and workspace as its fork's and nothing that says which is the pre-fork branch (OW-vezipo) — so a sentence promising the text was there would have pointed at a row nobody can pick out.

**Codex's parent turn survives.**
OW-gojado ran the probe this decision asked for on 2026-09-11 (home server, `codex-cli 0.154.0`, `gpt-5.6-luna`), firing `thread/fork` into a parent whose turn was positively confirmed streaming — `turn/started` seen, five `item/agentMessage/delta`s accumulated against a threshold of five, no `turn/completed`.
The fork succeeded, the parent emitted at least 300 further deltas and then `turn/completed` with `status: "completed"`, and a complete 1491-character reply landed in the parent's rollout on disk, whose hash the cell took immediately before the fork request and again after the parent settled (`docs/MANUAL_TESTING.md`, OW-gojado).
That replaced the inference this record used to carry, and the weak check behind it: `fork_probe.py`'s `parent_untouched` reads only the parent header's `forked_from_id`, which cannot tell a surviving turn from a killed one, so the new cell hashes the file and reads what it gained.

**Claude's parent turn survives too, once agentpane stops killing it.**
The kill was agentpane's, not the CLI's.
OW-japuzo measured that on the home server on 2026-09-11 (`claude 2.1.268`, `--model haiku`): a fork spawned as a second child rather than replacing the first came up and answered its own prompt while the parent emitted 160 further deltas, settled `success`, and wrote its whole reply durably.
The same run settled the price of the abort there, and it is larger than on Codex: nothing reaches `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` while the turn runs — four marks across one reply, byte-identical each time, the last at about 78% of a 1491-character answer — and a separate cell's read at `result` found the file still unchanged at the wire's end of turn, so a kill mid-turn destroys the entire reply rather than racing it.
How much of a Codex parent's partial reply is on disk at an abort was never measured, so this is a comparison of what the abort destroys and not of bytes.
OW-razoki then removed the kill from agentpane on 2026-09-13: `ClaudeAdapter.fork()` mints the fork's session id and returns the recipe to spawn it, and `replaceProcess` is deleted.
`SessionManager.fork` parks that recipe in `#pendingForks` for `#start` to consult ahead of the session index, which cannot answer for a fork whose store file does not exist until its first turn ends, and the fork then gets its own adapter and its own child down the attach path.
That attach path was Codex's first, and Codex has since left it: OW-lajehi found that as of `codex-cli` 0.154.0 only the app-server that minted a forked thread may open it, so a Codex fork gets its own adapter and shares the parent's child, while Claude's fork keeps a child of its own.
The live run that confirmed it end to end went through `bun run start` on the production spawn path (home server, 2026-09-13, `claude 2.1.270`, haiku): forked at a confirmed-streaming instant in three shapes, the parent finished its own reply every time and the store gained 7439, 7491 and 12549 bytes that the old kill would have destroyed (`docs/MANUAL_TESTING.md`, "A fork through agentpane leaves the parent's turn running and answers on its own child").

**Why this is a consequence rather than a choice.**
The question used to be framed as uniformity against letting the parent turn finish, and that framing assumed a fork on Claude had to kill the parent.
It did not.
With Codex and Claude both leaving the parent alone, the only backend that loses the turn is the one whose CLI abandons it regardless, so nobody has to weigh uniformity against a surviving reply.
The split that remains is not agentpane behaving inconsistently across backends — it is one backend genuinely behaving differently, which is what the labels are there to say.

That retires the uniformity argument, and it should not be restated.
It was the whole of this decision's case from OW-gojado's close until now, after that run took away the second reason the decision used to give — that a surviving turn "streams into a session nobody is looking at, tokens spent to produce an orphan", which the run is the counterexample to: the reply is durable in the parent's rollout, the parent is a session agentpane lists and the user can navigate back to, and the tokens are spent either way, since the abort lands after the model has already produced most of the reply.
Uniformity was doing its heaviest work on the backend whose cost had never been weighed at all: Claude does not appear in this record's pre-2026-09-13 text once, and is the one backend where the abort destroys a whole reply that would otherwise have landed.
Retiring the kill removed that cost instead of paying it.

**The behaviour now matches.**
OW-bakosi landed it on 2026-09-13: `forkAndSubmit` aborts only where `ref.backend` is `pi`, and the comment above that line states the asymmetry rather than the uniformity it used to argue.
The labels went with it, because the label follows the behaviour — `sendLabel` and the composer's "Stop and edit" shortcut read "Stop and ..." only where the stop is real, both off one derived `stopsBeforeFork` in `App.svelte` that reads the same selected ref the controller decides on.
`src/client/controller.test.ts` and `src/client/App.test.ts` pin both halves per backend.

### D16. A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects

`submit()` during a running turn means *steer*: the text joins the turn already in flight, delivered at the backend's next safe point.
An adapter whose backend cannot do that rejects the submission rather than doing something else with it.
The owner took this on 2026-09-09 (OW-rifezo).

Before this, the same user action did three different things and the composer drew one Send button over all of them: Codex threw `TURN_ACTIVE_ERROR`, Pi sent `streamingBehavior: "steer"`, and Claude wrote another user line to stdin.
Claude Code 2.1.267 settled that last behavior live on the home server (OW-jihete): a user line written after the first text delta was not acknowledged until after the first `result`, then ran as a separate second turn, while a `steer` control request returned `Unsupported control request subtype: steer` immediately.
The Claude adapter now rejects `submit()` while a turn is active, and applies the same single-flight gate to `/compact`, so no adapter path knowingly enters the CLI's queue.
The contract said only "resolves once the backend admits the turn", which all three honoured.

Steer is the pick because it is what a person typing mid-turn is asking for, and a follow-up delivers the text somewhere the user did not aim it.
Pi's own default for a message typed mid-turn is steer (`pi/process.ts:291-294`), which is corroboration and not the reason.
The alternative, standardising on follow-up, was the reachable-everywhere option and was declined: reaching it everywhere would have meant holding prompts server-side for Codex to simulate a primitive it does not have, in order to give every backend the weaker semantic.

Rejection is a real answer here, not a failure mode.
The route already turns an adapter throw into a 500, and `controller.ts`'s `submit` clears the draft only on success, so a rejected mid-turn prompt leaves the user's text where they typed it.
What an adapter must not do is silently downgrade to a follow-up, which is indistinguishable from success at the wire and puts the prompt after the turn without saying so.

Pi steers, Claude rejects because its backend cannot steer, and Codex steers.
Pi's half of that was the last one resting on a reading rather than a run, and it was measured on the home server on 2026-09-14 against `pi 0.85.1` (OW-yuyofu), six runs through the built server on the production spawn chain.
A prompt posted while a turn was streaming came back 202, and **the one thing that tells a steer from a follow-up is that Pi named the queue it went into**: `queue_update` came back with the text in `steering` and `followUp` empty, in every run.
That single fact carries the conclusion.
The other fact the runs establish is necessary for this decision but does not discriminate: the marker was answered without the session ever returning to idle — `agent_settled`, which `src/server/adapters/pi/reducer.ts` maps to `isStreaming: false` and which is therefore the boundary this decision is written about, fell nowhere between the request and its answer in any run.
That rules out a follow-up delivered *after* the turn, which is the failure mode this decision names; it does not rule out a `followUp` queue drained inside the same span, because the reducer's own docblock records that an `agent_end` can be followed by queued continuations.
So the queue name is the evidence and the boundary is the corroboration, not two independent readings agreeing.
Two finer signals deliberately decide nothing: Pi's `turn_start`/`turn_end` bound one LLM round and carry no id at all, so OW-tifuha's "same turn id" reading has no Pi equivalent and could not have one — `resources/fixtures/pi/tool-read.jsonl`, captured long before any of this, already holds two of those pairs inside one `agent_start`…`agent_settled` span — and `agent_end`, the inner agent loop, came out both ways across the runs depending on how much the model had left to say.
Three things that measurement does not reach: no run cut an in-flight assistant message short, no turn in it called a tool, so Pi's documented "deliver after the current tool batch" is still unexercised, and `streamingBehavior: "followUp"` was never sent, because the adapter never sends it — what Pi would do with one is inference here and not measurement.
`docs/MANUAL_TESTING.md`, "A prompt posted mid-turn is steered into Pi's running turn", carries the run.
`turn/steer` was run live on the home server on 2026-09-12 against `codex-cli 0.154.0` (OW-tifuha): fired 29 deltas into a streaming turn with `expectedTurnId` set to that turn, it returned a result naming the same turn id, and both the steered `userMessage` and the answering `agentMessage` arrived under that turn id, with exactly one `turn/completed` and no second turn.
The Codex adapter's `submit()` now sends `turn/steer` whenever it holds an unambiguously correlated `turnId`; it still rejects when a turn is in flight under an id it cannot name, because `expectedTurnId` is a precondition and there is nothing to put in it.
`compact()` keeps its rejection regardless, and `submit()` gained one of its own for the same reason: `compact` is one of the two `NonSteerableTurnKind`s and a compaction runs as its own turn, so a `turnId` naming a compaction is a turn app-server will refuse to steer.
OW-jihete's fixture and OW-tifuha's section in `docs/MANUAL_TESTING.md` preserve both observations.

The effect on the accidental double-submit OW-nasofa describes — a second Ctrl-Enter during the round trip, which `App.svelte`'s `send()` and `controller.ts`'s `submit()` both fail to guard — runs in both directions, per backend.
On Claude it is an improvement: a silently queued duplicate becomes a rejection with the draft intact.
On Codex it is a regression now that OW-tifuha has landed: the former clean rejection is a duplicate steered into the running turn.
On Pi nothing changes, because Pi already steers it.
So this decision does not remove the need for OW-nasofa's in-flight guard, and on one backend it is what will make that guard load-bearing.

Steering also cost Codex an invariant the fork path leaned on: a steered turn holds two user messages where `listForkPoints` answers one point per turn, so the ordinal `controller.ts` computed by counting user messages no longer indexed the fork-point list.
That desynchronization was OW-roveze, and it was silent — a later Edit forked at the wrong turn rather than failing.
D20 below retires the counting; the invariant is gone rather than restored, and the steered message is simply not a fork target.
The narrower window between `abort()` and `turn/completed`, where a steer hits a turn being torn down, is OW-pefawi.

### D17. Navigating away during a fork does not cancel it

Pressing send in edit mode forks the session and prompts the fork.
Clicking another session while that round trip is in flight moves the user, and nothing else: the fork is still created, still attached and still prompted, and the user ends up with both conversations.
The owner took this on 2026-09-10 (OW-miyemo).

The gesture asks for two things — make a new conversation, and take me to it — and OW-mifuki decided the click wins the second.
It left the first unanswered, and the answer that had accreted by default was the worst of the three available: the fork was created and then abandoned mid-round-trip, so the user got a session nothing had attached, nothing had prompted, and nobody had told them about.
It surfaced later in the sidebar as a near-duplicate of its parent, because every backend's fork carries the parent's history and the sidebar preview is taken from the first user message in the file.

A click is navigation, not a retraction.
Nothing in the UI presents it as a cancel, and a user who wanted to call the fork off has no reason to believe that clicking elsewhere is how.
So the fork completes and the prompt lands; the fork streams in the background and badges when it finishes, which is the mechanism that already exists for a session that streams while the user is looking elsewhere (OW-mifuki's arming, re-keyed onto the landed ref).

The two alternatives were priced on OW-miyemo and declined.
*Leave the orphan* is what was happening already and is what this decision replaces.
*Delete the orphan* does not work with what exists: `DELETE /api/sessions/:backend/:id` routes to `close()`, which kills the process and drops the session from the table but touches nothing on disk, while `listSessions` is a pure disk walk with no filter — so the row survives the delete.
Making the row disappear would mean a new route that unlinks the transcript, and that is agentpane crossing from reading someone else's corpus (D9) to owning it, which it has never done.
That crossing may be worth making one day, but an edge case is a poor reason to force it, and on Pi it would mean unlinking the file the live process believes it is in.

What this changes in `forkAndSubmit` is that the intent guards stop being cancel guards.
They returned `null` after each await; under this decision the operation always runs to completion and the only thing conditional on the intent is whether `applyAttached` moves the selection.
This also retires the case the card called worse in kind: a click landing in the `api.abort` window used to kill the parent's turn and then abandon everything, so the user lost a turn and got nothing — and the button said "Stop and fork", so they had asked for the stop but not for the nothing.
Both now stand.

The sharp edge is the `selectionIntent` bump, which is why the guards were written as returns rather than as a choice.
The fork bumps the intent just before it attaches, because a fork that takes the selection must fence off a preview poll still in flight.
A fork that declines the selection must not bump: bumping past the user's own click strands it, leaving their `attachAndSelect` in its `else` branch with the selection never set and `busy` stuck on `"attaching"` forever.
So the bump is conditional on the fork actually taking the selection, and that condition has to be captured before the bump, which destroys the information it is read from.

### D18. Backend facts carry the version they were measured on, and only the ones that license absent code are defended against time

Pi, Codex and Claude Code all move forward continuously and this project never rolls back, so every observed fact about them is decaying from the moment it is written.
The owner decided on 2026-09-11 that the answer is not to chase currency but to sort the facts by what their going stale actually costs.

Three groups, and they are not treated alike.

- **Facts the code already defends against.** That a Codex fork does not inherit `sandbox` (D7a) is one: the adapter passes it explicitly on all three thread-creation paths, so if a future Codex starts inheriting, nothing breaks and the docblock is merely over-explained. These are allowed to rot and are corrected when someone trips on them.
- **Facts behind a decision already taken.** D15's per-backend fork behaviour, D7a's policy choice. If one flips, a decision may want revisiting, but nothing fails silently and the decision record says what it rested on. These are corrected on contact too.
- **Facts that license code that does not exist.** These are the only ones defended against time. The shape is always the same: a run showed that some input cannot arrive, so nothing was built to handle it; the backend then changes, the input arrives, and there is no test to go red and no log line, because the missing code is exactly what would have noticed. The live instance is agent requests — OW-zogogo asks whether any Codex `ServerRequest` kind can still reach agentpane, and OW-bijera stays unbuilt on the current answer of no.

For that third group the defence is not documentation, it is a runtime assertion: the impossible input is made loud where it arrives, so a backend upgrade that reopens the hole reports itself the first time it happens instead of presenting as intermittent flakiness months later.
That assertion exists for Codex `ServerRequest`s as of OW-nujawi: a kind with no entry in `DECLINE_RESPONSES` is answered at arrival with JSON-RPC `-32601` naming the method and raises a session error, so the turn fails in seconds with the kind on screen.
The three approval kinds keep their pending path, because a decline shape is a handler and there is nothing surprising about their arrival.

Two supporting practices follow, and neither is a promise to re-verify everything.

Prose asserting backend behaviour names the version it was measured on; `AGENTS.md` carries the rule.
Present tense without a version is the defect this decision is named after: "app-server defaults each thread to `read-only`" was measured on codex-cli 0.147.0 and still read as current after the 0.154.0 run that sat three lines below it in this file.
That instance was closed on 2026-09-12 by re-measuring it rather than by stamping it — the value had not in fact moved (OW-pibivi) — which is the outcome the rule is indifferent to and the reason it asks for the version either way.

Fixtures are the one place the first group turns into the third without anyone writing a sentence.
A fixture under `resources/fixtures/` makes two claims: that the reducer handles the shape it holds, which a test proves and which never goes stale, and that the installed CLI still produces that shape, which no test can prove and which the suite nevertheless asserts on every green run.
The two claims get separate vehicles.
The fixture stays as it is, stamped with the version it was captured on and never treated as current, because its job is the first claim and re-capturing it on every bump buys nothing for that claim while costing a live run, a scrub review and a fresh nondeterministic reply.
The second claim belongs to a live run on the installed CLI: the smoke scripts in `resources/probes/` drive a real turn through agentpane, and after that turn the event types seen are diffed against the newest fixture for the scenario and the delta printed (OW-pukado).
`resources/fixtures/*/*.meta.json` already carries `cli_version`, `event_census` and `server_requests_seen` per capture, which is the baseline that diff runs against.
A re-capture happens only on a signal from that delta — a type added or removed, or a live reducer failure — and replaces only the scenario that moved; count drift is noise and triggers nothing.
One fixture per scenario, and git history holds the old shapes.
Nothing else is re-verified on a bump by policy, which is the part that keeps the rule above from being read as an obligation to keep every document current.

Rejected: pinning backend versions, which converts drift into a different debt the project has already said it will not pay; and failing `bun run check` when the installed CLI moves, which turns every upgrade into a red build over facts that mostly do not matter.


### D19. A Codex subagent shows in the parent as one collapsed tool card per collab operation, and its rollout stays in the session picker

A spawned Codex agent is a thread of its own, sharing the parent's app-server connection (HANDOFF finding 49).
OW-fafeja stopped the child's items from leaking into the parent transcript, which left the parent showing nothing at all for a subagent: its turn appeared to pause for minutes inside a `wait` with no trace of why.

What the parent actually receives is `collabAgentToolCall`, one item per `spawnAgent` / `sendInput` / `resumeAgent` / `wait` / `closeAgent`, each arriving `item/started` then `item/completed` (`resources/fixtures/codex/subagent.jsonl`, captured on `codex-cli 0.153.4`, which exercised spawn and wait).
Each becomes the tool-call pair the renderer already knows, under the single name `subagent`, with the operation in `arguments.tool` and the child thread id in `arguments.threadIds`.
The `wait` completion carries the child's final message in `agentsStates[childId].message`, so the block shows what the subagent answered without reading the child thread at all.
The parent therefore reads "spawned agent", then "waited", in sequence, collapsed by default like any other tool card.

This is the **live attached** transcript's view, and only that.
A stored rollout records the same calls as Responses-API `function_call`s under the `collaboration` namespace — `wait_agent`, `send_message`, `spawn_agent`, `followup_task`, `list_agents` and `interrupt_agent`, counted across the 72 September rollouts on the home server on 2026-09-11 (`codex-cli` 0.150.1 through 0.154.0) — so `extractCodexPreviewTurns` names them `collaboration__wait_agent` and the read-only preview of the same parent draws an opaque default card with no child link at all.
Closing that gap is separate work.

The child's conversation is **not** inlined as a nested block.
A subagent can run many minutes and many tool calls while the parent is blocked in `wait`, so a nested view would dominate the parent transcript for exactly the confusing effect OW-fafeja removed.
Claude Code's adapter already keeps subagent transcripts out of the parent (`src/server/sessions/claude.ts`), and this keeps the two backends consistent.

Instead the card names the child thread and offers to open it, through the same `controller.preview` path a click in the session list takes.

**Subagent rollouts stay in the session picker, and ease decided it.**
The owner stated on 2026-09-09 that they had no preference either way, and listing them is what the code already does — no filter exists, so this decision cost nothing to take.
The noise is real: on the home server on 2026-09-11, 45 of the 72 September Codex rollouts carried `thread_source: "subagent"` in their `session_meta` (written by `codex-cli` 0.150.1 through 0.154.0).
Whichever way it had gone, only the listing would have moved — `getSession` and the preview route resolve a ref by filename and would keep reaching a hidden child, which is what the card's link asks for.
So the card is a shortcut to a door that already exists rather than the only way in.

### D20. A fork point names its transcript index, and a message no point names is not editable

`ForkPoint` carries the index, in the session's flat transcript, of the user message it forks at.
The client resolves a fork point by matching that index against the message the user clicked, and offers an Edit control only on messages some point names.
The owner took this on 2026-09-13 (OW-roveze).

What it replaces is positional addressing: `GET fork-points` was specified to answer one point per user message in transcript order, so the client counted user messages before the clicked one and indexed the list with that ordinal.
Nothing carried the correspondence — `PaneMessage` has no id and D11 freezes `protocol.ts`, so it could not grow one — and the two lists agreed only by convention.
D16's steering broke the convention on Codex, and the failure was silent in the worst way available: with a later turn present the ordinal still resolved, to a point one whole turn past where the user pointed, with no error and nothing on screen to notice.

Making Codex answer one point per user message was the obvious repair and is wrong.
`ThreadForkParams.lastTurnId` is the only cut Codex offers and `thread/rollback` was deprecated in the bindings vendored on 2026-08-10 and is gone from the `codex-cli 0.156.0` ones, so a per-message point would be a point that cannot be forked at — worse than none.
Folding the steered message into its turn's first message was also declined: it hides a steer that really shipped.

So the unevenness is shipped instead.
Inside one steered Codex turn, the first user message carries an Edit control and the steered one does not.
That is visibly odd and it is the intended outcome: it tells the truth about where the backend can cut, and every alternative papers over it.
Every backend now pays the same way — Pi pairs its `get_fork_messages` entries against its own transcript server-side and answers with nothing at all if the two lists disagree on length, and Claude derives each point's index by replaying the store through the reducer that built the transcript, which fixed a pre-existing off-by-one where a compaction summary emitted a point with no user message behind it.

Knowing the set at render time costs a round trip the old client did not make: the client fetches fork points on attach, at each turn boundary and on any snapshot, and holds the indices for the selected session only.
That set is an affordance and may be briefly stale; nothing is decided on it.
`forkAndSubmit` refetches at submit and resolves by index, refusing rather than falling back — so the worst a stale affordance can produce is a refusal, never a fork somewhere the user did not point.

### D21. A re-established event stream asks for a session listing, and the first open does not

Every re-establish of the SSE stream asks for one unsurfaced session listing, so state that moved while the connection was down heals without a gesture.
The owner took this on 2026-09-16 (OW-vukoku).

Reconnection before this healed transcripts and nothing else.
`openEventStream` sends opening snapshots only for the sessions holding a live adapter, and a `snapshot` carries `{ session, seq, messages, isStreaming, compaction, model }` -- no `status`, no `updatedAt`, no `cwd`, no `preview`.
`Last-Event-ID` appears nowhere in `src/`, so there is no cursor and no replay buffer either: a `sessions-changed` fanout that happened while the socket was down is lost rather than deferred.
Of the eight `SessionSummary` fields, `status` and `updatedAt` are the two that go both wrong and visible, and a listing is the only thing that moves either.
`status` lights the sidebar's attached stripe and is the first conjunct of the composer Tools menu's `detachable`, which reads `"attached"` or `"virtual"`.
`updatedAt` drives the whole sidebar ordering; it is the session file's mtime for a stored session, and `session.createdAt` for one the manager minted itself, which `#ownSummary` reports as both stamps.
`isStreaming` is the one field reconnection effectively heals, and only because the UI reads it live-first.

What it replaces is OW-lejahi, landed one commit earlier and narrower: `detach()` asked for its own re-list because a detach performed while the stream was down left the row lit as attached until the user pressed Refresh.
That was one visible instance of a general loss.
The reconnect re-list subsumes it for a stored session -- a detach with the stream up rides the `sessions-changed` the close broadcasts, and a detach with it down heals at the next open -- so that call came out of the ordinary path with this decision.

It stays on the exit `detach()` takes for a session with nothing on disk, because the row such a detach leaves behind is a different kind of wrong.
A detached stored session lists with an untrue `status` and is otherwise real: the transcript is on disk and a click reaches it.
A detached session with nothing on disk is gone everywhere -- no file, dropped from the manager's table -- while its row still stands in `summaries` and still renders, and `readSessionPreview` answers its ref with an empty-but-non-null transcript, so a click strands the user on precisely the screen OW-vasubu exists to keep them off.
The exit is chosen by the summary's `onDisk`, not by the id: attach replaces the `virtual:` id before any prompt (D9, as corrected by OW-bohodu) and a fork never has one, so a session created here and detached before its first turn, and a fork detached before its first turn ended, take this exit too (OW-wedupe).
A stripe that lies can wait for the stream; a clickable phantom cannot, least of all for a stream that may never come back up -- which is OW-dekuri, where a fatally closed `EventSource` fires no further `onopen` at all.

Not on the first open, which is the whole of the mechanism's subtlety.
`EventSource` fires `onopen` on the initial connect as well as on every re-establish, `controller.start()` already lists there, and `refreshSessions`'s only guard is `refreshInFlight`, which coalesces listings that overlap and not ones that follow each other.
An open landing after the startup listing resolved would therefore list a second time for nothing.
The predicate is that a listing has *landed*, not that an open has been counted: `refreshSessions` swallows its own failure and resolves, so a page that loads while the server is away -- listing rejected, connect failing, `EventSource` retrying -- gets its first `onopen` of all when the server returns, and that is the open where the sidebar is emptiest and the skip costs most.
Two booleans in the controller's closure, then: the stream has been up, and a listing has landed.

The cost is one `GET /api/sessions` per reconnect, and what that costs today is not measured here.
The route was timed at 0.16-0.24s warm over 1001 stored sessions on 2026-08-14, against a running production server whose machine that record does not name (`docs/MANUAL_TESTING.md`, "Observed preview and listing timing").
Behind it is OW-23, which separates the walk from the read: enumerating 583 Codex and 390 Pi files across 28 workspaces took ~0.01s and reading the first line of all 973 of them ~0.27s, in Python, on the work laptop on 2026-08-10 (`docs/HANDOFF.md`, finding 19) -- and the shipped parsers read further than the first line, so that figure understates the read rather than describing it.
Both predate the Claude Code store joining the enumeration, so neither describes the current route and nothing has re-measured it.
What is bounded is the frequency: `addClient` pushes `retry: 500` as the stream's first bytes, with no backoff and no cap on either side, so a flap costs roughly two listings a second.

Declined: any debounce, throttle or minimum interval on the re-list.
That storm arrives only when the server is already failing to hold a stream open, and a guard sized for it would be untested code defending a state in which the listing it protects is the least of the user's problems.

### D22. The Emacs client is a native `agentpane-mode` over a JSON-RPC helper agentpane owns, not `agent-shell` over an ACP shim

The owner took this on 2026-09-22 (OW-vibipo), on the evidence OW-dekate produced.

Two streams of cards described an Emacs client, filed 2026-09-13 and 2026-09-15.
The shim stream -- OW-fenobo, OW-basoga, OW-limejo, with OW-mikuyo deferred behind it -- put `agent-shell` over an ACP shim that is a client of the HTTP API, on the case that no Emacs rendering is written and every fork and session fact stays agentpane's.
The native stream -- OW-mutufa, OW-refibu, OW-wavone, OW-gunuke, OW-fojike -- put a native major mode over a JSON-RPC protocol agentpane owns, on the case that such a protocol has a field for everything ACP had to smuggle: the fork point, the model gate and `request` events.
OW-wawipu belongs to neither and stands.

What narrowed it, recorded in OW-vibipo before the verdict.
Fork was not a differentiator: ACP's `session/fork` carries no point, but OW-limejo already answered that with `_meta.agentpane.entryId` and a picker over `/fork-points`, so the shim would have forked at a message as well as the native mode.
The shim's real cost was four gaps ACP has no carrier for -- compaction state, `sessions-changed`, `status` and `isStreaming` in the session list, and `issuerThreadId` with `effort` -- which the card left as cost, not verdict.
The owner then ran `agent-shell` bare on the home server for some days, without any shim, and reported on 2026-09-21: what was missed was the fast session list and fork, which the shim cards would have restored, and what was disliked was the rendering, which after significant tuning looked okay and which the shim could not touch.
Everything liked -- staying in Emacs, Magit and back, long messages edited in place, `RET` and `C-RET`, inline prompt or separate composer -- is Emacs's, not `agent-shell`'s, and a native mode carries it for a keymap.
So the streams differed on rendering alone, and the shim's case, that no rendering is written, was gone the moment rendering was being tuned anyway.

What decided it is a rough cut looked at, which is the owner's practice for a UI decision and the reason OW-dekate existed: a renderer is judged by eye over rounds, not by argument.
OW-dekate drew OW-mutufa's nodes into an `ewoc` buffer over two evenings, 2026-09-21 and 2026-09-22, the owner at a live Emacs 31.1.50 on the work laptop beside the browser, with two stored sessions dumped through `src/emacs/dump-nodes.ts`, one Claude with Edit diffs and a markdown table and one Codex with fenced shell.
A `markdown-mode` backend got everything but tables, and a wide table wrapped at the window edge into nothing readable.
An `shr` backend drawing the browser's own HTML -- the sanitized string `renderMarkdown` in `src/client/render/markdown.ts` returns, produced under a jsdom window -- got headings, code, tints and real fitted columns; the owner's verdict was "this approach using shr is absolutely 100% a success", and what the card draws from it is that a native buffer now draws closer to the browser than tuned `agent-shell` does.
What it got right and wrong in detail, and the three Emacs facts the spike works around plus a fourth about the reload loop, are under "Rendering verdict, 2026-09-22" in OW-vibipo; the spike itself was `emacs/agentpane-spike.el`, absorbed into `emacs/agentpane.el` and deleted by OW-wavone.

What follows from it.
The shim stream's cards closed `--declined` on 2026-09-22 citing this decision, OW-mikuyo among them because the shim it was to be judged from is not built, and the standalone read-only browser it deferred is OW-wavone's first deliverable.
The helper of OW-refibu sends that HTML beside each text part's markdown source, since the buffer draws from it, and OW-wavone's Drawing list names `shr` and that field.
The spike's pretty-printer is the seed of OW-wavone's drawing and the spike file is deleted there.
D14 gained its sentence scoping the pointer rule to the browser client in the same change.

### D23. A conversation's model and effort are read back from its store's last turn, never kept by agentpane

The owner took this on 2026-09-23, after OW-kokalo, OW-ruzuhu and OW-hokaye landed a chosen effort for all three backends and each measured what a resume keeps of it.

A conversation's model and effort are chosen before its first prompt and fixed after it, by a gate in each client (`setModel` in `src/client/controller.ts`, `agentpane--check-model-gate` in `emacs/agentpane.el`).
Agentpane holds both only in memory -- the manager's session record and each adapter's own fields -- so a close, a D12 eviction or a server restart loses agentpane's copy; OW-jamoyi's run saw a Pi resume spawn carry no model after a close, and OW-pubulu found that Pi restores it itself.

Each backend's store already records both for every turn: Codex's rollout in each turn's `turn_context`, Claude Code on each assistant store line as `model` and `effort`, and Pi in its session file's `model_change` and `thinking_level_change` entries.
What each restores on a resume differs, measured for effort on 2026-09-23 (`docs/MANUAL_TESTING.md`, the three sections named for those cards, and OW-sayaju's for Codex):

| | Effort after a resume |
|---|---|
| Pi (`pi 0.87.1`) | the level the session file last recorded, clamped to the model the resume resolves, and recorded again only if the file held none (OW-lehita) |
| Codex (`codex-cli 0.156.0`) | the level its latest settings record names, which is the chosen one unless a resume that named a model reset it to the config's; a fork takes the config's |
| Claude Code (`claude 2.1.280`) | the default, not the chosen level |

What each restores of the model has been measured for all three, and only narrowly.
As of `pi 0.87.1`, a `--session` resume with no `--model` ran the model the session file last recorded over a settings default naming another, and an unsuffixed `--model` replaced that model while keeping the recorded level (`docs/MANUAL_TESTING.md`, OW-pubulu).
Where the recorded model had left the catalogue or its provider had lost its auth, the same resume ran the settings default, or another keyed provider's default, or no model at all, and said so nowhere over RPC: not on stdout, not on stderr, not in `get_state` (`docs/MANUAL_TESTING.md`, OW-zujofa).
So the Pi adapter infers it, comparing the model the resumed or forked branch last recorded with the one `get_state` names, and reports the recorded one as `unrestoredModel` on both wires' status and snapshot (OW-jitoni).
As of `codex-cli 0.156.0`, a `thread/resume` naming no model answered the model the thread's last turn ran over `config.toml`'s, in a fresh app-server and in the one holding the thread, while `thread/fork` answered `config.toml`'s (`docs/MANUAL_TESTING.md`, OW-sayaju).
As of `claude 2.1.280`, a `--resume` with no `--model` put in force the model the last assistant line a model ran records, over the settings' `opus[1m]` and over the same file's other lines naming another, and a `--fork-session` spawn put in force its kept prefix's rather than the file's last; a stored `claude-opus-5-5` came back as the settings' `claude-opus-5-5[1m]` variant, which passing the stored id as `--model` would drop (`docs/MANUAL_TESTING.md`, OW-nabano and OW-tebibo).

**The decision.**
On a resume and on a fork, a conversation runs at the model and effort its store's last turn recorded, and agentpane re-asserts them wherever the backend does not restore them itself.
The start-only gate is what makes the last turn enough: every stored turn names the same pair, so the last one's is the one chosen.
Where the backend restores a value itself, agentpane's part is not to override it; on Pi, a resume spawn whose `--model` carries a `:<thinking>` suffix overrides the recorded level (OW-ruzuhu's run).
A fork that keeps no turn, one cut before the first message, has no stored turn to read back, and runs at the parent's model and effort as they stand when it is cut: it is the parent's conversation begun again, not a new one at the backend's defaults.
Set by the owner on 2026-09-23 (OW-difowo), when Claude Code's such fork carried the parent's model but not its effort.
Pi forks inside the process that holds the parent, but that does not carry both by construction: as of `pi 0.87.1` that fork rebuilds the session from the process's command line, so a `--model` suffix's level comes back over the chosen one, and the `--model` itself over a model `set_model` chose (`docs/MANUAL_TESTING.md`, OW-dojebo and OW-sinoha), and a fork that keeps no message at all takes the settings default model and level (OW-riyeku).

**Why not a copy of agentpane's own.**
D13's paragraph on names already weighed this and chose the backend: no second copy to keep coherent, and agentpane stays one more UI over the agent rather than a store beside it.
The D13 file holds marks, not this.
A value read from the store also covers a session started outside agentpane, which no copy of agentpane's could.

A `virtual` session has nothing to lose: nothing is on disk before its first turn (D9), and its choice lives in memory until that turn is written.
The per-turn label is the same source read per turn rather than once: a loaded turn names the effort its own entries record, which is OW-helumu.
On Pi that is the recorded level clamped to the turn's model, since as of `pi 0.87.1` a resume that clamps the recorded level records nothing, and a level given on a resume's command line is recorded nowhere, so a turn run under one reloads with the level before it (`docs/MANUAL_TESTING.md`, OW-lehita).
What each backend needs from agentpane under this decision:

- **Codex** (OW-sayaju, OW-hojefo): a resume and a fork at an entry re-assert the model and effort the rollout's last `turn_context` recorded.
  No `thread/fork` keeps no turn: as of `codex-cli 0.156.0`, one with no `lastTurnId` kept the parent's whole history, and one naming an empty or unknown turn was refused (`docs/MANUAL_TESTING.md`, OW-hojefo).
  So a fork at the first fork point is a fresh thread its own adapter starts, carrying the parent's model onto `thread/start` and the parent's effort onto every `turn/start`, since that `thread/start` answered `config.toml`'s effort.
- **Claude Code** (OW-nabano, OW-tebibo, OW-faledu, OW-sababi): a resume and a fork at an entry pass no `--model`, since the CLI restores the stored model itself, `[1m]` variant included, and re-assert the stored effort, which it does not.
  A restored model is named by what the CLI put in force, so a fork before the first message, which is a fresh spawn, carries the `[1m]` variant a resume widened it to.
  That fork also spawns with `--effort` at the parent's effort in force when it was cut, or with none for a model that has no effort.
- **Pi** (OW-pubulu, OW-dojebo, OW-sinoha, OW-riyeku): nothing to re-assert on a resume, and on a fork the chosen model and level, or the parent's in force when the fork keeps no message.
  It restores both itself, so its resume spawn carries no `--model` at all.
  It forks inside the process that holds the parent, and as of `pi 0.87.1` a process spawned with `--model <m>:<level>` ran the turn after a fork at that level, over the level chosen before the first prompt, with its `get_state` naming it and the forked file recording nothing, so the adapter re-sends the chosen level after a fork.
  As of the same version that fork also took the spawn's `--model` over a model `set_model` chose, with `get_state` naming the spawn's model and the forked file still naming the chosen one (`docs/MANUAL_TESTING.md`, OW-sinoha), so the adapter re-sends the chosen model after a fork, before the level, since `set_model` resets the level.
  As of the same version a fork at the first user message of a session file holding no system message, which every file written before `pi 0.86.0` lacks, kept no message, so Pi had nothing to restore from: `get_state` answered `messageCount` 0 at the settings default model and level, and the forked branch recorded both (`docs/MANUAL_TESTING.md`, OW-riyeku).
  A resume spawn chooses nothing for the adapter to re-send, so after a fork whose `get_state` answers `messageCount` 0 it re-sends the model and level in force before the fork, chosen or not; a `0.87.1` file keeps its system message at that fork, and Pi restores both itself.

### D24. A live session is keyed by a handle agentpane mints, its mutations run one at a time, and a hydrate merges history with the live stream

The owner took this on 2026-09-24, after asking whether the race defects the deck keeps filing point at a flaw in the architecture.
Decided and not yet built, in the sense D12 is: the prose reads as the design will once the seven cards named at the end land, and each amendment to an earlier decision says so where it stands.

**What the deck showed.**
Of the 69 cards closed between 2026-09-22 and 2026-09-24, 8 were timing or ordering defects; 34 were the model-and-effort restore stream D23 records, and most of the rest were wire gaps and `codex-cli 0.156.0` moving.
So races were not where the time went, but they were where the fixes did not hold: six of the eight were closed with a guard at the site, a flag or a counter, and three of those six filed a sibling for the case the guard missed.
OW-zovaye closed the push path of a Pi fork's emit under the parent's ref and filed OW-nuzepi for the pull path; OW-zasozo held Pi's level behind a `settingModel` flag and filed OW-woyifu for two calls overlapping on it; OW-vijuyi kept live slots across a Codex re-attach's hydrate and filed OW-zudase for the items that had no slot yet.
Two other fixes created a race: OW-tewofe's route-side effort check made OW-zayefe's unsequenced Emacs requests fail, and OW-kelene's history paging widened OW-vijuyi's window.
The architecture is not the cause.
D2 and D3, a server-authoritative snapshot with a tail upsert, reduced once in `src/client/session-state.ts` for both clients, are what kept every one of those fixes local, and OW-bipume closed a whole class by putting three fields on the container and the snapshot.
Three narrower choices produce nearly every race card, each one family, and this decision replaces them.

**Identity: the backend's mutable id is the key, and the manager polls for changes.**
A `SessionRef` is the backend's own id (D9), which every backend replaces at attach, which Pi can move again at the first prompt and moves at every fork, and which `#start` canonicalises across spellings (OW-fumegi).
`BackendAdapter.ref` is a getter, and the contract tells the manager to re-read it after `start()`, `submit()` and `fork()` settle; `SessionManager.#adoptRef` does, at those three points, re-keying `#sessions` and `#pendingRequests`, retargeting `#aliases`, and broadcasting `renamed`, which each client answers by re-keying its own maps.
Every identity change lands between the adapter's move and the manager's next look, which is OW-zovaye and OW-nuzepi on a Pi fork and OW-hikefi on a Claude Code `init` that renames.
Every client map keyed by the id needs a rename tracker: six closures in `src/client/controller.ts`, `rekeySession` and `watchRename` in the browser, `agentpane--rekey` and `agentpane--absorb` in Emacs (OW-jafini), and the `session/renamed` the helper synthesizes for the three orderings OW-nuwive found; and D12's bookkeeping constraint exists only to keep a stamp off such a map.
Roughly seventy cards in the deck touch a rename, a re-key or an alias.

Two changes, in two cards.
An adapter announces its identity change as an event, `onRefChanged(ref, cause)`, fired synchronously before anything else it emits under the new ref, and the manager re-keys in that handler; the three polling points go, and with them the `forking` count and `#onUpdate` guard OW-zovaye added, since the container is under the fork's ref before the fork hydrates (OW-nikogo).
OW-hikefi's body named this fix on 2026-09-16, and it is the raise the FROZEN INTERFACE note in `src/server/adapters/types.ts` asks for.
One point keeps its wait: a rename announced inside `start()`, which all three adapters make, is held in a variable local to that `#start` call and applied once the adapter is published, as the polled one was, because until then `#attaching` holds the startup only under the requested and canonical keys, and re-keying earlier would let a `close()` or an attach under the new name miss the startup; a start that fails therefore never renames.
OW-suyinu, which keys the container by a handle that never changes, is where that wait dissolves.
OW-nikogo landed the event, and with it a Pi fork's hydrate reaches every client as a snapshot under the fork's ref, where it had been dropped; between the event and the hydrate the fork's ref reads the parent's un-rewound transcript, which the hydrate or the fork's attach heals, and a route on the parent's ref misses from the event on, as on any detached parent (OW-kekoji, D20).
Then the manager keys a live session by a handle it mints, opaque, unique for the server's lifetime and never changed, and carries every backend id the session has had as names on the container, so a rename is an attribute write and a lookup by any old name still resolves, which is D9's promise that the old id keeps working on REST routes (OW-suyinu).
The handle rides `SessionSummary` for a session the manager holds and every per-session event on both wires, the clients key their views by it (OW-kimaya, OW-danifa), and `renamed` is retired once both do (OW-mofuho).
What the split between a rename and a fork settled stays in force: a fork writes no alias, broadcasts no `renamed`, drops the parent's `stored`, `onDisk` and `error`, and leaves the parent detached (OW-kekoji, OW-suhoto, OW-sehaja); under a handle a Pi fork is a new container with a new handle and none of the parent's names.
Codex and Claude Code forks move no ref and fire nothing on the parent (OW-22, OW-razoki), and a parked fork gets its handle when parked (OW-lajehi).
Teardown stops an event-driven re-key by unsubscribing: `close()` and `disposeAll()` drop a container's subscriptions in the same synchronous run that takes it out of the table, so no event reaches `#adoptRef` for it afterwards, and the `ManagedSession.torndown` flag that stopped the polled re-key is retired with the polling (OW-yavewa, OW-jimasu, OW-nikogo).
D13's file is keyed by the backend id and stays so: it names a session on disk, which is an identity a handle does not have.
D21's reconnect gap narrows: a `renamed` missed while the stream was down no longer strands a view, since the opening snapshot under the handle carries the current ref.

**Serialisation: nothing on the server runs one session's mutations one at a time.**
The routes in `src/server/http/app.ts` reach the adapter directly for set-model, set-effort, compact, abort, fork points and reply, and only `submit` and `fork` go through the manager, for the re-key and not for order; OW-yavewa's close note records that nothing serialises the routes, each a concurrent `Bun.serve` handler.
The browser guards itself with `pendingModelSets` and `sending` (OW-nasofa, OW-kelede); Emacs re-derived the same guards a week later (OW-yoyiya, OW-yibimi) and has none for set-model, which is OW-woyifu's whole cause; and OW-zayefe was fixed by sequencing two requests in `emacs/agentpane.el`.
The model-and-effort pair is mirrored in three layers, each with an in-flight flag of its own: the Pi adapter's `chosenModel`, `chosenEffort` and `settingModel`, the container's `last*` mirrors, and the controller's pending sets.

The change, OW-sewewe: one queue per managed session, a promise chain on the container, through which `setModel`, `setEffort`, `compact`, `fork`, `reply` and `submit` run one at a time, with the routes calling the manager for all of them.
It orders admission only.
`submit` resolves when the backend admits the turn, so nothing queued waits behind a running turn, D16 stands, a mid-turn prompt steering on Pi and Codex and rejected on Claude Code, and holding a prompt until a turn ends, which OW-rifezo declined, is not reintroduced.
The guards the adapters own stay: Claude Code's `turnActive`, Codex's `interruptedTurnId` (OW-pefawi) and compaction guard, Pi's `settingModel`, each closing a window that ends on a backend event a queue of requests cannot see; with one `setModel` at a time Pi's boolean is exactly sufficient, which OW-woyifu says a counter alone would not be.
It does not dedupe: the clients' one-prompt-at-a-time guards stay as the double-press rule.
Close and shutdown are not queued; `#disposing`, `PendingStart.torndown` and `#terminate` are their order.
OW-sewewe landed it, and `abort` stays out: it must reach a running turn, which is never queued, so queued it could only wait behind a settings call, a fork or a Pi compaction, and out it keeps the second abort ahead of a Pi fork harmless (OW-relehi).
`listForkPoints`, a read, and `attach`, which creates the adapter the queue sits on, stay out too; `#serially`'s docblock in `src/server/http/session-manager.ts` gives each reason.
Two costs the queue brings are filed rather than guarded: on Pi a verb queued behind a compaction waits for it, since `pi 0.84.2` answers `compact` after `compaction_end` (OW-jileku), and a verb sent on a Pi parent's ref and queued behind its fork runs on the fork until OW-suyinu gives the fork its own container.
Since OW-nikogo that window closes at the adapter's `onRefChanged`: a verb sent on the parent's ref after it misses `#lookup`, and only one sent before it still runs on the fork, since `#serially` takes the container at call time.

**Hydrate: replace, while the live stream keeps arriving.**
`PiAdapter.hydrateMessages` replaces the transcript wholesale, on a resume and inside `fork()`; `CodexReducer.hydrate` did until OW-vijuyi laid the paged-in turns under the live slots, and still dropped a delta for an item that started before the attach, because that item had no slot (OW-zudase), until OW-dutute below.
Claude Code hydrates before it spawns and never rehydrates a live session, so it has no such window.
The change, OW-dutute: a hydrate is a merge on every adapter that can hydrate a live session, under D20's rule that every index a client holds keeps meaning what it meant (OW-roveze), and under what a Pi fork is, a truncation that excludes the forked-at message and leaves the parent's streamed partial in the abandoned file (OW-yudoni, OW-sededi), so on Pi the merge shrinks the transcript and drops the parent's in-flight slots rather than unioning them.
OW-dutute landed it, and measured each window before choosing the merge's shape (`docs/MANUAL_TESTING.md`, OW-dutute).
As of `codex-cli 0.156.0` a `thread/turns/list` at `itemsView: "full"` taken mid-stream listed the running turn as `inProgress` with its completed items only, leaving out the `agentMessage` still streaming, and `thread/resume` replayed no `item/started` for it, so its deltas were the only copy of its text until `item/completed`.
A delta for an item the reducer holds no slot for now opens one from the kind the delta names, laid after the history like any live slot the listing lacks, and `item/completed` replaces it where it stands; command output opens nothing, since alone it names no command.
OW-dirazu, the sibling filed by OW-dutute's adversarial read, gave the listing ownership of what went before the attach (`docs/MANUAL_TESTING.md`, OW-dirazu).
As of `codex-cli 0.156.0` every item still streaming, of each kind that could be caught, was left out of the listing, `thread/resume` read the thread `active` but named no turn, and the listing named the running turn `inProgress`, a compaction's with no items.
So on a borrowed re-attach `CodexReducer.hydrate` now takes the running turn from the listing, its streaming state, a compaction when it lists no items at all, and its id, which the adapter adopts as though `turn/started` had arrived, so `abort()` interrupts it, `submit()` steers it and `compact()` refuses.
A turn the stream settled while the history was paged in -- a `turn/started`, a `turn/completed`, or a status other than `active`, which names no turn -- and compaction state it set are newer than the page and win over it, and a cold resume, on a fresh app-server that can be running no turn, adopts none.
A slot a delta opened is headless and yields to a listed copy, with only the deltas that arrived after the page was asked for laid on top; that retired the unconditional "a live slot wins" rule OW-dutute's hydrate kept, while the delta still opens the slot, since for a streaming item nothing else carried its text.
As of `pi 0.87.1` nothing arrived in Pi's window at all, on a fork or on a resume: the abandoned turn's last events, `agent_settled` among them, preceded the `fork` response.
So on Pi the truncating merge is the replace `hydrateMessages` already made, and `src/server/adapters/pi/process.test.ts` pins it against a union.

**How a race fix is made from here.**
A guard at the site is not refused.
But a guard whose adversarial read names a case it misses has found that the state has the wrong owner, and the sibling is authored as the ownership change, naming the guard it retires; a second guard is not filed.
`AGENTS.md` carries that rule under "Evidence", and its "Dispatching an implementer" section has the reader ask the question at close time rather than a week later.
Three of the eight are what it cost to learn this.

**Decided, not yet built.**
Seven cards, labelled `d24` and filed 2026-09-24: OW-sewewe serialises the mutations; OW-dutute makes hydrate a merge; OW-nikogo adds the identity event; OW-suyinu mints the handle and puts it on both wires, blocked by OW-nikogo; OW-kimaya keys the shared reducer and the browser by it and OW-danifa keys agentpane-mode by it, both blocked by OW-suyinu; OW-mofuho retires `renamed`, blocked by both.
The order to run them in is settled in conversation, as `AGENTS.md` says of every set; the one proposed on the day was OW-sewewe, OW-dutute, OW-nikogo, OW-suyinu, then OW-kimaya and OW-danifa, then OW-mofuho, with a cold read at OW-nikogo and OW-suyinu before either starts.
The open cards that close under them: OW-woyifu under OW-sewewe, OW-zudase under OW-dutute, OW-nuzepi and OW-hikefi under OW-nikogo.

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

  // requests the agent initiates (D2a); undefined for backends without them
  onRequest?(cb: (req: AgentRequest) => Promise<AgentResponse>): Unsubscribe;

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
| `plan` | assistant text or a custom block | optional polish |
| `contextCompaction` | compaction summary message | Pi has a compaction message type; mirror it |
| `collabAgentToolCall` | `toolCall` + `toolResult`, named `subagent` | one card per collab operation, naming the child thread (D19) |

**This table is a sketch, not a registry.**
The registry is `src/server/adapters/codex/mapping.ts` — `mapItem`'s switch and the `SILENT_ITEM_TYPES` set above it, each arm carrying its own reasoning.
Two mapped types are missing here, `imageGeneration` and `imageView`, both of which produce output.
The table is deliberately not kept complete: Codex adds `ThreadItem` variants between releases, and `mapItem`'s doc comment says what happens to the ones nobody has taught it about.

**The `commandExecution` row is the live shape only.**
As of `codex-cli 0.155.1`, measured 2026-09-22, the live wire presents a shell run as `commandExecution`, while the rollout on disk stores it as a `custom_tool_call` named `exec` wrapping `tools.exec_command(...)` or as a `function_call` named `exec_command`.
The preview in `src/server/sessions/codex.ts` folds both stored shapes to `bash` so preview and live transcript agree; see `docs/MANUAL_TESTING.md`, "A Codex shell run is `commandExecution` live and `exec` or `exec_command` on disk (OW-jakahe)".

Content-block mapping (Codex `UserInput` → Pi content), done by `userInputToContent`: `text` → `TextContent`; `image` → `ImageContent` when the URL is a `data:` URL and a text reference otherwise; `localImage`, `audio`, `localAudio`, `skill` and `mention` → text references.
Why the two local variants degrade rather than load is recorded at `userInputToContent`.
(`ContentItem`, with its `input_text`/`input_image` variants, is the *legacy* type — v2's `userMessage` does not carry it.)

**The table above is not the whole stream.**
Captured turns also carry `turn/diff/updated` (a cumulative diff for the turn), `thread/tokenUsage/updated`, `thread/status/changed`, `thread/started`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated`, and `remoteControl/status/changed`.
Token usage feeds the cost display and status changes feed the streaming signal, so some of these belong in the adapter even though they are not messages.
Read a fixture before assuming this section is exhaustive.

Fixtures currently cover `userMessage`, `reasoning`, `agentMessage`, `commandExecution`, `fileChange`, `contextCompaction` (`resources/fixtures/codex/compact.jsonl`), and `collabAgentToolCall` (`resources/fixtures/codex/subagent.jsonl`, HANDOFF finding 49).
The remaining rows — `mcpToolCall`, `dynamicToolCall`, `webSearch`, `plan` — have no capture yet; add a scenario when implementing each.

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

Three subprocess facts, each verified while building the Pi adapter and each capable of producing a bug that looks like something else entirely:

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
  Re-provable with `resources/probes/agentpane_{codex,pi}_smoke.py`.

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

Open questions are cards; `card list --open --label question` is their only current list.
They carry ids and sit beside everything else outstanding because keeping a second list here is what previously let this document drift out of step with the deck.
A question that settles comes back here as a decision, with its reasoning — that is what this document is for, and it is why the one below stayed.

- ~~**Whether killing the spawned process actually stops the agent.**~~
  **Settled, for Pi and Codex.**
  `direnv` and the sbox wrapper `exec` into the chain rather than surviving beside it, so the server's own child is the `bwrap` chain and a signal does reach the agent at the bottom of it.
  SIGTERM to the server left no run-scoped worker behind for either `codex app-server` or `pi --mode rpc` (HANDOFF findings 34 and 39).
  Three defects had to be fixed before that held: `dispose()` did not await the child's close on either side, and an adapter still inside `start()` was invisible to shutdown entirely (findings 36 and 37).
  Re-provable with the two harnesses in `resources/probes/`.
