# Minimal Live Vertical Slice Design

## Goal

Deliver the first usable agentpane workflow: choose a workspace and backend,
create or attach a session, see its transcript, submit a text prompt, watch the
turn stream, and abort it. Prove the assembled application with a live Codex
turn while retaining Pi through fixture and contract coverage.

This milestone is intentionally narrow. Forking, model selection, image input,
approval-response UI, comprehensive session browsing, and visual polish remain
out of scope.

## Delivery strategy

Build the client against the existing wire contract and test doubles first,
then wire the real server dependencies, then recover and verify the parked
Codex adapter. This keeps failures attributable to one boundary:

1. The client state machine is proven against synthetic REST and SSE traffic.
2. The shell is proven against that state machine without an agent process.
3. The server is wired to the existing session index and adapter factories.
4. The Codex adapter is reviewed and integrated from `wip/codex-adapter`.
5. A live Codex turn proves the entire browser-to-agent path.

Pi is not called live from this environment. Its existing fixtures, reducer
tests, subprocess tests, and adapter contract tests remain required, and the
milestone records a short manual Pi smoke procedure for execution outside this
sandbox.

## Architecture

### Client API boundary

A focused client module owns calls to the routes in
`src/shared/protocol.ts`. It lists sessions, creates a virtual session,
attaches a session, submits a prompt, and aborts a turn. Non-2xx responses are
decoded from `ApiError` when possible and exposed as readable errors.

The module also opens the single multiplexed `EventSource` at `ROUTES.events`.
It parses each payload as a `ServerEvent` and reports malformed events without
destroying the last valid client state. Native `EventSource` reconnection is
used; the client does not invent a second retry loop or a resume-token
protocol.

### Client session state

A separate state module owns all mutable session state. The Svelte components
render it and invoke its commands; they do not implement transport semantics.
The state includes:

- the known session summaries;
- the selected, authoritative `SessionRef`;
- messages and `isStreaming` for the selected session;
- the last sequence number seen for each live session;
- connection, attach, submission, and user-visible error state.

The reducer follows the existing server-authoritative protocol:

- `snapshot` replaces the transcript and resets that session's sequence;
- `upsert` replaces or appends exactly the indexed message;
- `status` changes only `isStreaming`;
- `renamed` re-keys every client value held under `from`, including the
  selected ref and sequence state, before the following snapshot arrives;
- `sessions-changed` schedules a session-list refresh;
- `error` becomes a visible session error;
- `request` is retained as an unsupported pending request and surfaced to the
  user rather than silently discarded.

If a non-snapshot event's sequence is not the expected successor, the client
reattaches the affected session so the server emits an authoritative snapshot.
It does not attempt to replay missing deltas.

### Minimal shell

The shell has three functional areas:

1. A compact session control area accepts an absolute workspace path, selects
   Pi or Codex, creates a virtual session, and shows sessions matching the
   current workspace. Selecting a session attaches it.
2. The existing `Transcript` component renders the selected session's messages
   and streaming state.
3. A text composer submits a non-empty prompt. While streaming, an Abort action
   is available. Submission errors preserve the draft so it can be retried.

The shell displays explicit empty, connecting, and error states. It does not
add a routing library, global state dependency, component library, or design
system. Renderer tokens move to a once-imported app stylesheet only if the
shell needs them; otherwise that cleanup stays outside the milestone.

### Server composition

`src/server/index.ts` stops using `emptySessionIndex` and an empty adapter
registry. A small session-index adapter supplies both operations required by
the HTTP layer:

- `list(query)` delegates to the existing filesystem enumeration;
- `get(ref)` finds the requested summary without spawning an agent.

The production registry includes `PiAdapterFactory` immediately. It includes
the Codex factory only after the parked adapter passes review and the full
verification suite. Listing sessions remains a filesystem-only operation.

### Codex adapter recovery

The parked `wip/codex-adapter` work is treated as untrusted input, not as a
finished feature. It is integrated from a fresh branch based on current
`main`, then reviewed in this order:

1. generated protocol types and JSON-RPC framing;
2. fixture-driven reducer and `ThreadItem` mapping;
3. request/reply correlation and approval handling;
4. process startup, shutdown, abort, and error behavior;
5. `BackendAdapter` conformance and session identity.

The adapter must use the generated bindings under `resources/codex-protocol/`
as its type authority. Captured fixtures remain the default test input; live
model calls are not part of the ordinary test suite.

## Data flow

For a new turn:

1. The shell creates a virtual session through `POST /api/sessions` or selects
   an existing summary.
2. It attaches through `GET /api/sessions/:backend/:id` and adopts the
   authoritative ref returned in `AttachSessionResponse`.
3. It submits text through the prompt route.
4. The server's `SessionManager` drives the adapter and converts adapter state
   changes into multiplexed SSE events.
5. The client state reducer applies snapshots, tail upserts, status changes,
   and any session rename.
6. Svelte rerenders `Transcript` from assembled `AgentMessage[]` state.

The HTTP response only confirms acceptance. Turn progress and completion come
from SSE, so the UI never infers completion from the prompt request finishing.

## Error handling

- Invalid workspace input is rejected before session creation and remains
  editable.
- Failed list, create, attach, prompt, and abort calls produce distinct visible
  errors and do not erase the last valid transcript.
- A dropped SSE connection shows a reconnecting state; native reconnection and
  opening snapshots restore live state.
- A sequence gap triggers reattach-and-snapshot recovery once for that gap.
- A session rename is applied atomically before subsequent events are handled.
- An unsupported agent request is displayed as blocking and actionable in the
  sense that the user is told this milestone cannot answer it. Approval UI is
  a later milestone; live Codex testing must use a configuration or scenario
  that does not require an unanswered approval.
- Server shutdown continues to dispose adapters through the existing app
  lifecycle.

## Testing and verification

### Automated offline tests

- API helpers: correct routes and bodies, response decoding, and error cases.
- Event parser/reducer: every `ServerEvent` variant, session filtering,
  sequence gaps, snapshot reset, and rename re-keying.
- Shell: create/select/attach, transcript rendering, preserved prompt drafts,
  streaming controls, reconnect/error states, and abort.
- Server composition: real index wrapper behavior and adapter registry wiring
  without spawning live agents.
- Codex adapter: table-driven fixture tests for text, reasoning, command
  execution, file changes, streaming deltas, completion, and requests.
- Full `bun run check`, including all existing Pi tests, remains mandatory.

Tests for state and protocol behavior assert structure rather than model text.
Any defect fix must first demonstrate a failing test against the unfixed code.

### Live Codex verification

Run the assembled server with a writable temporary `CODEX_HOME` carrying the
required credentials, then verify:

1. the browser creates a Codex session for this workspace;
2. one text-only prompt streams into the transcript;
3. completion clears the streaming state;
4. refresh/reconnect repaints the transcript without spawning a duplicate
   process;
5. abort stops a deliberately long turn;
6. server shutdown leaves no Codex child process behind.

This may begin as a documented manual smoke run. A deterministic scripted-agent
browser test is preferable once the live integration surface is stable; live
model wording is never asserted.

### Deferred Pi verification

Record, but do not claim as completed from this environment, a manual check of:

- `direnv -> sbox/bwrap -> pi` startup;
- first-prompt virtual-id materialization and the `renamed` event;
- real streaming and tool output in the browser;
- abort and shutdown signal propagation with no orphaned Pi process.

## Completion criteria

The milestone is complete when the offline suite is green, the minimal shell
works through the real production server composition, the live Codex checklist
passes, no process leak is observed for Codex, and the unperformed Pi checks
are explicitly documented rather than implied to have passed.
