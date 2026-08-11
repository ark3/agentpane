# Workstreams

The build was split into slices. They were originally built **in parallel**,
each in its own git worktree; all six slices are now integrated on
`feature/minimal-live-vertical-slice`.

This document is the current state of each slice and the contracts they expose.
Read `HANDOFF.md` and `DESIGN.md` first — they carry the decisions and the
evidence. Live verification details and its exact scope are in
`MANUAL_TESTING.md`.

## Status (2026-08-11)

| Slice | State | Where |
|---|---|---|
| session-index | **done, offline verified** | this branch |
| pi-adapter | **done, offline verified** through fixtures, process tests, and contracts; live Pi remains deferred | this branch |
| transport | **done, verified** offline and through the live Codex REST/SSE path | this branch |
| renderer | **done, offline verified** including edit, image-result, thinking, and sanitization paths | this branch |
| codex-adapter | **done, verified** against fixtures and a live `codex-cli 0.147.0` turn | this branch |
| client-shell | **done, offline verified**; the production-built client returned HTTP 200, but no browser automation was run | this branch |

**A green `bun run check` is not verification.** `wip/pi-adapter` passed on
merge — and its largest file, the 293-line process shell, had no tests at all
and held four real defects, including one that hung `start()` forever on a
failed spawn. Read a branch before trusting its exit code.

The assembled milestone has 551 offline tests. On 2026-08-11, the production
server also completed the six Codex smoke checks: create/attach, incremental
text updates, idle completion, reconnect repaint without another native Codex
worker, abort, and shutdown without an orphan. That run served the built client
and drove REST/SSE with a local harness; it did **not** automate browser UI
interaction. Pi was **not** live-tested in this environment.

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
  whole surface: `Transcript` takes `{ messages, isStreaming }`, and
  `registerToolRenderer(name, component)` teaches it a backend-specific tool.
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

## Conventions

- **Runtime is Bun**; tests are vitest. `bun install` first.
- **`bun run check` must pass** before you are done (typecheck + svelte-check +
  all tests). Not just your own tests.
- **Two test projects.** Server-side tests (`src/server/**`, `src/shared/**`)
  run in `node`; client tests (`src/client/**`) run in `jsdom`. Put the file in
  the right place rather than writing a per-file environment docblock.
- **Path aliases**: `$shared/*`, `$server/*`, `$client/*`. Imports carry real
  `.ts` extensions.
- **The pi packages are types-only** (D10). `import type` only —
  `src/import-boundaries.test.ts` fails the build otherwise, naming your file.
- Assert on **structure**, never on model wording — fixture text varies per
  capture.
- **Verify at the source**, which is HANDOFF's one rule. Where a claim about a
  CLI, a protocol, or a runtime is load-bearing, reproduce it and record how.
  The most expensive defect found so far was an unexamined assumption about
  which events `node:child_process` emits when a spawn fails.
- **A test that has never failed has not been shown to test anything.** For a
  fix, break it again and watch the test go red before you trust it.

## Recording what you find

A finding that lives only in a chat transcript dies with the session — which is
how the first round's reports were lost. Put them where they survive:

- A defect in these documents: **fix the document**, in the same change.
- A fact you had to verify: the commit message, or `DESIGN.md` when it changes
  a decision rather than confirming one.
- Something you could not resolve: DESIGN's "Remaining open questions".
