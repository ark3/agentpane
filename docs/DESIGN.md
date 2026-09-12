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
A session's id changes under the client during normal use — Pi's id *is* its JSONL path (D9) and a `virtual` session has no path until its first prompt materialises one — so the id the browser created a session with is not the id it keeps.
The server keeps honouring the old id on REST routes indefinitely, but every event after the change carries the new one, so a client that ignores `renamed` renders a live session into a transcript nothing updates.
See D9's "Three states".

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

This is provisional and OW-bijera is what revisits it: once a human can answer, holding becomes the right behaviour again for the kinds they can answer.
It is therefore sequenced *before* bijera rather than after, because declining honestly needs the retraction this contract has always lacked -- see the paragraph below.

**A resolved request has no wire event, and that is a gap, not a decision.**
`ServerEvent` carries `request` and nothing that retracts it, so the browser is never told a request stopped being pending -- not when this client answers it, not when another does, and not when Codex resolves it itself through auto-approval.
The client's `requests` array is append-only for that reason (`src/client/session-state.ts`, the `request` arm of `reduceServerEvent`), which is why a declined request would otherwise leave a warning standing over a turn that had already moved on.
The Codex reducer already produces a `request-resolved` effect that the adapter consumes and drops, so the missing piece is the wire event and the client arm, not the detection (OW-gusifo).

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

Re-querying the agent (Pi `get_messages`, Codex `thread/read`, Claude Code's own store file) remains the **cold-start** path — server restarted, or attaching to a session that predates it.
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
The intent is to avoid permission prompts, not to route them into agentpane's UI: agentpane has no approval dialog, so an approval `ServerRequest` renders as a single warning naming the kind and the turn then hangs until the session is killed.
The real trade is "no dialog" against "a hung turn", and the hung turn is worse.

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
  Materialised on first prompt (pipane uses a `__new__` sentinel), so browsing never litters the backend's store with empty sessions.
- `detached` — exists on disk, no subprocess.
- `attached` — live subprocess.

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
Transcripts come from `thread/read` / `get_entries` on an attached session; since subprocesses outlive connections, switching back to a recent session is instant anyway.

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
(There is no explicit "end session" control in the UI to retire — the `DELETE` route exists but nothing in the client invokes it; idle+LRU is simply the reclamation that was missing.
The route stays: it is useful programmatically and shutdown-adjacent code leans on it.)

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
   Before the first prompt writes JSONL there is nothing on disk to rehydrate from — eviction would be data loss, not detach.

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
- Keyed by `sessionKey(ref)`, and **no mark on a `virtual` session**: D9's rename on first prompt would strand a key placed before it.
- The server does not filter.
  `SessionSummary` carries the mark and the client decides what to draw, because a "show hidden" control needs the rows in hand either way and this leaves the route's meaning unchanged.

**A corrupt file is reported, not logged.**
If the file will not parse, it is renamed aside and the store starts empty -- keeping the evidence rather than eating it -- and the server *tells the browser*.
A log line on a headless server is indistinguishable from swallowing it, which this repo already has a name for (OW-15).
Reporting it needs a session-less `notice` arm on the `ServerEvent` union, since every error today carries a `session` ref and a per-session `seq` and this condition belongs to no session.
It lands with this feature rather than ahead of it, following the pattern the compaction work used for `compact()`, and it is small because `sessions-changed` is already a session-less, seq-less arm.
It will not stay single-use: a D12 reaper eviction and a spawn that fails before any session exists are both server-global and both currently unreportable.

### D14. Every affordance is reachable with a pointer; the keyboard types text

The owner's rule, stated on 2026-08-19: **nothing in this UI requires the keyboard except typing text into the composer.**
Keyboard paths are welcome alongside -- Escape to dismiss, Enter to send -- but never as the only way to reach a behaviour.

This is a constraint on what gets built rather than a rendering detail, which is why it is here and not inside the item that provoked it: it binds every UI item written from now on, and the next one should not have to rediscover it.

The default it exists to stop is not hypothetical.
OW-hezidi was filed with "whether cancel is a button or Escape" listed among the incidentals to decide in flight, which left it open that the only way out of an editing mode would be a key -- caught the same day, but filed that way first.
A pointer user who enters a mode and does not know the key is stuck in it, and that item's whole design rests on entering the mode being cheap and abandonable.
Escape as well is right; Escape only is the failure.

So: when an interaction introduces a mode, the control that leaves it is visible and clickable, and it is drawn where the mode announces itself rather than somewhere the user has to go looking.

### D15. agentpane stops a streaming turn before forking it, on every backend

Submitting an edit of an earlier message forks the session, and where a turn is streaming at that moment `forkAndSubmit` aborts it first, identically on Pi and on Codex.
The owner took this on 2026-09-09, replacing the "first cut, safe on both" that OW-hezidi shipped it as.

Pi leaves no choice: a mid-stream fork there returns `success: true` and abandons the in-flight turn anyway — the active `sessionFile` moves, `isStreaming` goes false, and `agent_settled` arrives carrying no assistant text (`docs/MANUAL_TESTING.md`, OW-yudoni).
That section retired a third observation from the same run as a tautology, and the two above are what it says survives; nobody has yet read the file the abandoned turn was streaming into, so the conclusion rests on the settle rather than on a search for a partial reply.
The abort does not cause that loss; it makes it deliberate and visible instead of silent.

Codex is the side where a choice exists, and it is a real one: the parent turn survives.
OW-gojado ran the probe this decision asked for on 2026-09-11 (home server, `codex-cli 0.154.0`, `gpt-5.6-luna`), firing `thread/fork` into a parent whose turn was positively confirmed streaming — `turn/started` seen, six `item/agentMessage/delta`s accumulated against a threshold of five, no `turn/completed`.
The fork succeeded, the parent emitted at least 300 further deltas and then `turn/completed` with `status: "completed"`, and a complete 1491-character reply landed in the parent's rollout on disk, whose hash the cell took immediately before the fork request and again after the parent settled (`docs/MANUAL_TESTING.md`, OW-gojado).
That replaces the inference this paragraph used to carry, and the weak check behind it: `fork_probe.py`'s `parent_untouched` reads only the parent header's `forked_from_id`, which cannot tell a surviving turn from a killed one, so the new cell hashes the file and reads what it gained.

The abort stays, and the honest reason is uniformity alone.
The second reason this decision used to give — that a surviving turn streams into a session nobody is looking at, tokens spent to produce an orphan — is the part OW-gojado weakened.
The surviving turn completed and wrote its whole reply durably into the parent's rollout, and that parent is a session agentpane lists and the user can navigate back to; it is not an orphan, and the tokens are spent either way, since the abort lands after the model has already produced most of the reply.
What is left is that Pi cannot be brought to match, so a backend-dependent answer here would be permanent rather than pending — which is exactly OW-hezidi's worry that the split "reads as a bug".
Uniform behaviour across backends is the whole of the case, and it is stated that way rather than propped up by a cost the run showed is smaller than it sounded.

So the two backends differ as a matter of fact, and agentpane's uniformity is a choice laid over that difference rather than a description of it.
Whether to take the asymmetry after all is a decision this record does not take; if it is ever taken, the label follows the behaviour — `sendLabel` and the "Stop and edit" button both read "Stop and ..." only because the stop is real.

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

Pi is already correct, Claude rejects because its backend cannot steer, and Codex steers.
`turn/steer` was run live on the home server on 2026-09-12 against `codex-cli 0.154.0` (OW-tifuha): fired 29 deltas into a streaming turn with `expectedTurnId` set to that turn, it returned a result naming the same turn id, and both the steered `userMessage` and the answering `agentMessage` arrived under that turn id, with exactly one `turn/completed` and no second turn.
The Codex adapter's `submit()` now sends `turn/steer` whenever it holds an unambiguously correlated `turnId`; it still rejects when a turn is in flight under an id it cannot name, because `expectedTurnId` is a precondition and there is nothing to put in it.
`compact()` keeps its rejection regardless, and `submit()` gained one of its own for the same reason: `compact` is one of the two `NonSteerableTurnKind`s and a compaction runs as its own turn, so a `turnId` naming a compaction is a turn app-server will refuse to steer.
OW-jihete's fixture and OW-tifuha's section in `docs/MANUAL_TESTING.md` preserve both observations.

The effect on the accidental double-submit OW-nasofa describes — a second Ctrl-Enter during the round trip, which `App.svelte`'s `send()` and `controller.ts`'s `submit()` both fail to guard — runs in both directions, per backend.
On Claude it is an improvement: a silently queued duplicate becomes a rejection with the draft intact.
On Codex it is a regression now that OW-tifuha has landed: the former clean rejection is a duplicate steered into the running turn.
On Pi nothing changes, because Pi already steers it.
So this decision does not remove the need for OW-nasofa's in-flight guard, and on one backend it is what will make that guard load-bearing.

Steering also costs Codex an invariant the fork path leans on: a steered turn holds two user messages where `listForkPoints` answers one point per turn, so the ordinal `controller.ts` computes by counting user messages no longer indexes the fork-point list.
That desynchronization is OW-roveze, and it is silent — a later Edit forks at the wrong turn rather than failing.
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
- **Facts behind a decision already taken.** D15's uniformity, D7a's policy choice. If one flips, a decision may want revisiting, but nothing fails silently and the decision record says what it rested on. These are corrected on contact too.
- **Facts that license code that does not exist.** These are the only ones defended against time. The shape is always the same: a run showed that some input cannot arrive, so nothing was built to handle it; the backend then changes, the input arrives, and there is no test to go red and no log line, because the missing code is exactly what would have noticed. The live instance is agent requests — OW-zogogo asks whether any Codex `ServerRequest` kind can still reach agentpane, and OW-bijera stays unbuilt on the current answer of no.

For that third group the defence is not documentation, it is a runtime assertion: the impossible input is made loud where it arrives, so a backend upgrade that reopens the hole reports itself the first time it happens instead of presenting as intermittent flakiness months later.
That assertion exists for Codex `ServerRequest`s as of OW-nujawi: a kind with no entry in `DECLINE_RESPONSES` is answered at arrival with JSON-RPC `-32601` naming the method and raises a session error, so the turn fails in seconds with the kind on screen.
The three approval kinds keep their pending path, because a decline shape is a handler and there is nothing surprising about their arrival.

Two supporting practices follow, and neither is a promise to re-verify everything.

Prose asserting backend behaviour names the version it was measured on; `AGENTS.md` carries the rule.
Present tense without a version is the defect this decision is named after: "app-server defaults each thread to `read-only`" was measured on codex-cli 0.147.0 and still read as current after the 0.154.0 run that sat three lines below it in this file.

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
  That injection is keyed on the command name, so it applies to `codex` and not to the surrounding wrapper — but it is a **no-op for `app-server`**, which ignores the CLI flag and defaults each thread to `read-only`.
  The sandbox policy that actually takes effect is set per `thread/start` by the adapter (OW-37); `danger-full-access` there, since sbox's bwrap jail is already the confinement boundary.
  "Per `thread/start`" is shorthand for all three thread-creation calls — `thread/start`, `thread/resume` and `thread/fork` — each of which carries both the sandbox and `approvalPolicy: "never"`, for the reasons in D7a.
  `thread/fork` needs `sandbox` spelled out because a fork inherits the parent's `approvalPolicy` but **not** its sandbox, falling back to `workspaceWrite` (OW-18).
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
