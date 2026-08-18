# Workstreams

The build was split into slices. They were originally built **in parallel**,
each in its own git worktree; all six are now integrated and merged to `main`.

This document is the current state of each slice and the contracts they expose.
Read `HANDOFF.md` and `DESIGN.md` first — they carry the decisions and the
evidence. Live verification details and its exact scope are in
`MANUAL_TESTING.md`.

## Status

**This table is the single statement of project status.** README, DESIGN and
MANUAL_TESTING link here rather than restating it; `MANUAL_TESTING.md` holds
the evidence behind the "verified" claims, and `docs/work/open/` holds what is
still outstanding, one file per item. If you change what is true, change it
here.

| Slice | State | Where |
|---|---|---|
| session-index | **done, offline verified** | main |
| pi-adapter | **done, offline and live verified** through fixtures, process tests, contracts, and the live `direnv -> sbox -> pi` REST/SSE path | main |
| transport | **done, verified** offline and through the live REST/SSE path on both backends | main |
| renderer | **done, offline verified** including edit, image-result, thinking, and sanitization paths | main |
| codex-adapter | **done, fixture and live-smoke verified**; the final review's lifecycle findings are fixed | main |
| client-shell | **offline verified, and hand-tested live in a browser** (open: OW-24, OW-42, OW-48, OW-49, OW-55, OW-56, OW-66 — also server-side, OW-75, OW-tesofu) | main |

**A green `bun run check` is not verification.** `wip/pi-adapter` passed on
merge — and its largest file, the 293-line process shell, had no tests at all
and held four real defects, including one that hung `start()` forever on a
failed spawn. Read a branch before trusting its exit code.

The assembled milestone's offline suite is broad and has continued to grow, but
that is not the thing the live verification settled. On 2026-08-11, the
production server completed the normal-path Codex smoke checks: create/attach,
incremental text updates, idle completion, reconnect repaint without another
native Codex worker, abort, and shutdown without an orphan in that run. **Pi
has since been run live through the same composition** — the production
`direnv -> sbox -> pi` chain, the id rename, streaming, abort, and shutdown
without an orphan, which together settle DESIGN's third open question for both
backends. Those two backend-backed runs served the built client and drove
REST/SSE with a local harness rather than browser UI interaction. Browser
automation now exists, but only as OW-47's narrow Playwright vehicle (`e2e/`)
against a synthetic backend, so a real browser path through the production
server and a real backend turn remains the largest unverified surface (OW-24).

The final review's release blocker — an adapter still inside `start()` being
invisible to `close()`/`disposeAll()`, so shutdown could return having orphaned
it — is fixed and pinned by regressions that were confirmed failing first, and
the live smoke was re-run against the fixed tree with tightened abort, process
scope, and cleanup criteria. One honest limit remains: **no browser
automation of a real backend-backed turn.** (An earlier revision of this
paragraph also claimed "no live Pi", which the paragraph above it had already
contradicted — the Pi live run closed that gap on 2026-08-11.)

### What the Pi adapter expects of its caller

Two contracts the server has to honour, both documented at their definitions:

- **Re-read `adapter.ref` after `start()` and after the first `submit()`.**
  Pi's session id *is* its JSONL path (D9), and a `virtual` session has no path
  until its first prompt materialises it. The adapter adopts the real
  `sessionFile` as soon as Pi reports one, so a session keyed by the
  pre-materialisation id will not be findable on disk afterwards.
- **`start({ resumeId })` hydrates the transcript itself**, via `get_messages`.
  The caller does not need to re-query; a resumed adapter already holds the
  conversation by the time `start()` resolves.

Both are now honoured, in `SessionManager.#adoptRef`. The first one was *not*
honoured by the merged `wip/transport`, and it is the reason a new Pi session
was unusable: the process table kept it keyed under its `virtual:` id forever,
so it listed twice, was never findable on disk, and re-opening it spawned a
second agent on the same session file. If you write a third adapter, `ref` is
not stable — say where it changes, and the server will follow.

### What the transport expects of its callers

- **Drive turns through `SessionManager.submit`, not `adapter.submit`.** That is
  where the rename above is picked up. Reaching past it re-introduces the bug.
- **`SessionSummary.ref` from `GET /api/sessions/:backend/:id` is
  authoritative** and may differ from the ref in the URL, for the same reason.
- **A client must handle the `renamed` SSE event** by re-keying everything it
  holds under `from`. A snapshot under the new ref follows immediately. The old
  id keeps working on REST routes indefinitely, so an in-flight POST is safe,
  but no *event* will ever carry it again.
- **`/api` rejects a non-loopback `Origin`** (D8). Nothing to do from the app;
  it matters if you ever test the API from a page served from somewhere else.

### What the renderer expects of its callers

- **Mount `Transcript` and nothing else.** `src/client/render/index.ts` is the
  whole surface: `Transcript` takes `{ messages, isStreaming, reading }`, and
  `registerToolRenderer(name, component)` teaches it a backend-specific tool.
  `reading` (OW-51) elides tool and thinking chrome; it changes what renders,
  never what the caller passes in.
- **The design tokens live in `Transcript.svelte`'s `:global(:root)` block.**
  That keeps the package importable with nothing to wire up, but it also means
  the palette only exists while a transcript is mounted. A shell that wants the
  same tokens for its own chrome should lift that block into
  `src/client/app.css` and import it once — the note is in the component.
- **An edit-shaped tool call must carry its replacements as either an `edits[]`
  array or a flat `oldText`/`newText` (or `old_string`/`new_string`) pair**, or
  the card renders no diff. Pi's own shape is the array (HANDOFF 31). This is
  the one place the renderer cares what an adapter puts in `ToolCall.arguments`;
  everything else degrades to the default card.
- **Upsert the tail message in place.** The `{#each}` key is
  `index:role:timestamp`, so replacing the tail `AgentMessage` object mid-turn
  updates the existing DOM rather than rebuilding it — which is what keeps
  disclosure state and the markdown throttle alive. Pi keeps `timestamp` stable
  from `message_start` to `message_end`; an adapter that renumbers it per token
  would repaint the whole message on every token.
- **Everything the renderer puts on the page is sanitized**, but only because
  the two entry points (`renderMarkdown`, `renderCode`) both end in DOMPurify.
  Anything else reaching `{@html}` is a new hole; there is no second net.

## File ownership

Disjoint ownership was the defence against parallel agents colliding in the
same files. It still describes where code belongs, but it is no longer a
prohibition: **integration is now the job.**

| Slice | Owns | Verify against |
|---|---|---|
| **pi-adapter** | `src/server/adapters/pi/` | `resources/fixtures/pi/*.jsonl` |
| **codex-adapter** | `src/server/adapters/codex/` | `resources/fixtures/codex/*.jsonl` |
| **session-index** | `src/server/sessions/` | the real `~/.pi/agent/sessions` and `~/.codex/sessions` |
| **transport** | `src/server/http/`, `src/server/index.ts` | the wire contract, with a fake adapter |
| **renderer** | `src/client/render/` | hand-built `AgentMessage[]` samples |
| **client-shell** | `src/client/App.svelte`, `src/client/main.ts` | the running app |

## The shared interfaces

- `src/shared/protocol.ts` — the wire contract (D11). SSE event union, REST
  request/response types, `ROUTES`, `SessionRef`, `SessionSummary`.
- `src/server/adapters/types.ts` — `BackendAdapter`, which both adapters
  implement identically.

These were frozen so that agents who could not talk to each other could build
against them without drift. Serially that constraint is lifted: change them
when the design calls for it, but deliberately — a change ripples into every
unmerged `wip/*` branch, and `git diff main...wip/<slice>` is how you find out
how far.

## How work gets done

Process rules live where they load: `CLAUDE.md` for what applies to anyone
touching the repo, `/author` for writing work items, `/execute` for landing
them. This document holds slice status and the contracts, not the process and
not the work items — those are one file each under `docs/work/`.
