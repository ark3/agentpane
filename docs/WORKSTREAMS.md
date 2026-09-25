# Workstreams

This document records the current state of each build slice and the cross-component contracts that are easy to violate.
`DESIGN.md` carries the decisions, `HANDOFF.md` the evidence behind them, and `MANUAL_TESTING.md` the exact scope of live verification.

## Status

**This table is the single statement of project status.**
README, DESIGN and MANUAL_TESTING link here rather than restating it; `MANUAL_TESTING.md` holds the evidence behind the "verified" claims, and `card list --open` shows what is still outstanding.
If you change what is true, change it here.

| Slice | State | Where |
|---|---|---|
| session-index | **done, offline verified** | main |
| pi-adapter | **done, offline and live verified** through fixtures, process tests, contracts, and the live `direnv -> sbox -> pi` REST/SSE path | main |
| transport | **done, verified** offline and through live turns on Pi, Codex, and Claude Code | main |
| renderer | **done, offline verified** including edit, image-result, thinking, and sanitization paths | main |
| codex-adapter | **done, fixture and live-smoke verified**; the final review's lifecycle findings are fixed | main |
| claude-adapter | **done, fixture and live verified** through a Haiku turn with thinking, text, and tool use | main |
| client-shell | **offline verified and hand-tested live in a browser** | main |

The evidence behind every "verified" claim lives in `MANUAL_TESTING.md` rather than being restated here.
Outstanding work lives only in the card deck.

### What the Pi adapter expects of its caller

Two contracts the server has to honour, both documented at their definitions:

- **Follow `adapter.ref` through `onRefChanged`.**
  Pi's session id *is* its JSONL path (D9), which Pi names from `start()`'s `get_state` as of `pi 0.87.1`, though the file is not written until the first turn; the probe after the first `submit()` covers a Pi that has named nothing by then, and every fork moves it again.
  The adapter adopts the real `sessionFile` as soon as Pi reports one and announces it then, so a session keyed by its minted `virtual:` id will never match a file on disk.
  Until D24 (OW-nikogo) this contract read "re-read `adapter.ref` after `start()` and after the first `submit()`", and the manager polled at those points and after `fork()`.
- **`start({ resumeId })` hydrates the transcript itself**, via `get_messages`.
  The caller does not need to re-query; a resumed adapter already holds the conversation by the time `start()` resolves.

Both are now honoured, the first by the `onRefChanged` handler `SessionManager.#start` subscribes, which writes a renamed id onto the session's container as one more name through `#rename`, and moves a fork onto a container of its own through `#forkOnto` (D24, OW-suyinu).
The first one was *not* honoured by the merged `wip/transport`, and it is the reason a new Pi session was unusable: the process table kept it keyed under its `virtual:` id forever, so it listed twice, was never findable on disk, and re-opening it spawned a second agent on the same session file.
If you write another adapter, `ref` is not stable — fire `onRefChanged` where it changes, before anything else you emit under the new id, and the server will follow.

### What the transport expects of its callers

- **Drive turns through `SessionManager.submit`, not `adapter.submit`.**
  That is where the prompt joins the session's queue (D24, OW-sewewe) and clears its error and its `virtual` flag.
  The rename above no longer depends on it: the manager hears it through `onRefChanged` whoever drove the turn.
- **`SessionSummary.ref` from `GET /api/sessions/:backend/:id` is authoritative** and may differ from the ref in the URL, for the same reason.
- **A client keys what it holds for a live session by its `handle`**, which every per-session event carries beside the ref and a rename never moves (D24, OW-suyinu), and takes the ref from the events as an attribute that may change under it.
  The browser's reducer does (OW-kimaya): an event under a known handle whose `session` is a new ref moves the view, the summary carrying that handle and the selection onto it, so a `renamed` it never received strands nothing.
  agentpane-mode does the same since OW-danifa, and takes from the helper's `session/renamed` the ref it moves to, as from any notification under the handle, and the handle of an attach whose reply has not yet come (`agentpane--notified-buffer` in `emacs/agentpane.el`); a snapshot under the new ref follows immediately, and `renamed` retires once nothing needs it (OW-mofuho).
  `renamed` means one conversation took a new id, and nothing else does: the old id keeps working on REST routes indefinitely, so an in-flight POST is safe, but no *event* will ever carry it again, and a client is right to move its selection across.
  A fork never emits it, on any backend (OW-suhoto) — a fork creates a second conversation and the parent keeps its own id, so all a fork tells other clients is `sessions-changed`.
- **`/api` rejects a non-loopback `Origin`** (D8).
  Nothing to do from the app; it matters if you ever test the API from a page served from somewhere else.

### What the renderer expects of its callers

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

## Code map

| Slice | Owns | Verify against |
|---|---|---|
| **pi-adapter** | `src/server/adapters/pi/` | `resources/fixtures/pi/*.jsonl` |
| **codex-adapter** | `src/server/adapters/codex/` | `resources/fixtures/codex/*.jsonl` |
| **claude-adapter** | `src/server/adapters/claude/` | `resources/fixtures/claude/*.jsonl` |
| **session-index** | `src/server/sessions/` | the real Pi, Codex, and Claude Code session stores |
| **transport** | `src/server/http/`, `src/server/index.ts` | the wire contract, with a fake adapter |
| **renderer** | `src/client/render/` | hand-built `AgentMessage[]` samples |
| **client-shell** | `src/client/App.svelte`, `src/client/main.ts` | the running app |

## The shared interfaces

- `src/shared/protocol.ts` — the wire contract (D11).
  SSE event union, REST request/response types, `ROUTES`, `SessionRef`, `SessionSummary`.
- `src/server/adapters/types.ts` — `BackendAdapter`, which all adapters implement identically.

Change these interfaces deliberately: each one joins several slices.
