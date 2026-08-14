# Workstreams

The build was split into slices. They were originally built **in parallel**,
each in its own git worktree; all six are now integrated and merged to `main`.

This document is the current state of each slice and the contracts they expose.
Read `HANDOFF.md` and `DESIGN.md` first — they carry the decisions and the
evidence. Live verification details and its exact scope are in
`MANUAL_TESTING.md`.

## Status (2026-08-12)

**This table is the single statement of project status.** README, DESIGN and
MANUAL_TESTING link here rather than restating it; `MANUAL_TESTING.md` holds
the evidence behind the "verified" claims, and **Open work** below holds
everything still outstanding. If you change what is true, change it here.

| Slice | State | Where |
|---|---|---|
| session-index | **done, offline verified** | main |
| pi-adapter | **done, offline and live verified** through fixtures, process tests, contracts, and the live `direnv -> sbox -> pi` REST/SSE path | main |
| transport | **done, verified** offline and through the live REST/SSE path on both backends | main |
| renderer | **done, offline verified** including edit, image-result, thinking, and sanitization paths | main |
| codex-adapter | **done, fixture and live-smoke verified**; the final review's lifecycle findings are fixed | main |
| client-shell | **offline verified, and hand-tested live in a browser (still no automated DOM test — OW-24).** Opened by hand on 2026-08-12: the layout defect in OW-26 made it impractical to test; OW-26 is now fixed, and of the defects it exposed, OW-27, OW-28, OW-30, OW-31, and OW-36 are fixed. OW-29 remains open | main |

**A green `bun run check` is not verification.** `wip/pi-adapter` passed on
merge — and its largest file, the 293-line process shell, had no tests at all
and held four real defects, including one that hung `start()` forever on a
failed spawn. Read a branch before trusting its exit code.

The assembled milestone has 566 offline tests. On 2026-08-11, the production
server completed the normal-path Codex smoke checks: create/attach, incremental
text updates, idle completion, reconnect repaint without another native Codex
worker, abort, and shutdown without an orphan in that run. **Pi has since been
run live through the same composition** — the production `direnv -> sbox ->
pi` chain, the id rename, streaming, abort, and shutdown without an orphan,
which together settle DESIGN's third open question for both backends. Both runs
served the built client and drove REST/SSE with a local harness; neither
automated browser UI interaction, which is now the largest unverified surface.

The final review's release blocker — an adapter still inside `start()` being
invisible to `close()`/`disposeAll()`, so shutdown could return having orphaned
it — is fixed and pinned by regressions that were confirmed failing first, and
the live smoke was re-run against the fixed tree with tightened abort, process
scope, and cleanup criteria. One honest limit remains: **no browser
automation.** (An earlier revision of this paragraph also claimed "no live Pi",
which the paragraph above it had already contradicted — the Pi live run closed
that gap on 2026-08-11.)

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

## Open work

**Everything outstanding lives here**, in one list with stable ids. Before this
was consolidated the same items were spread across three documents — this
file's deferrals, DESIGN's "Remaining open questions", and MANUAL_TESTING's
"Still unverified" — and drifted, in one case into a flat self-contradiction
about whether Pi had been run live. Other documents now cite an `OW-` id
instead of restating the item.

Four kinds share the list, because they share a lifecycle:

- **deferral** — review found it, judged it not worth blocking on. None is a
  defect in a path the milestone exercises.
- **defect** — observed or read as broken, and nothing depends on leaving it
  that way. The client-shell rows are all of this kind.
- **question** — a decision nobody has made yet. When one settles it leaves
  this list and becomes a decision in `DESIGN.md`, which is where the reasoning
  belongs.
- **unverified** — believed to work, never proven. Closing one means producing
  evidence, and the evidence goes in `MANUAL_TESTING.md`.

They are here because a finding that lives only in a session transcript dies
with it — this list is the surviving copy. Each was recorded by whoever found
it and **not re-verified since; confirm against the source before acting on
one** — OW-23 was stale enough to invert its own conclusion. Adding a row costs
a line: take the next id, never reuse one. Closing one moves it to
`docs/CLOSED.md` with its sha and the evidence, so this list stays scannable.

This shape is a deliberate experiment: a markdown table standing in for an
issue tracker, chosen over adopting one (beads) because development is
serialized and nothing here needs assignees or concurrent claims. The columns
are the ones a tracker would want, so importing stays mechanical. Revisit if
the list starts wanting fields this table cannot carry — dependency edges
between rows, or who holds what.

| ID | Kind | Where | Item |
|---|---|---|---|
| OW-1 | deferral | `src/shared/protocol.ts` | The wire contract says a snapshot resets the sequence, but not whether it should also clear a transient `error` or a pending `request`. The client preserves both when a session view already exists, which is a choice the contract does not sanction either way. |
| OW-2 | deferral | client SSE adapter | Every native `error` callback is reported as a disconnect, and no reconnect/backoff policy exists anywhere — the browser's own `EventSource` retry is the whole story. Fine on loopback; nothing owns it if that stops being true. |
| OW-3 | deferral | client workspace input | `setWorkspace` fires per keystroke, so typing an absolute path can enumerate every prefix of it. Decide between debouncing and committing on blur. |
| OW-4 | deferral | Codex reducer | A multi-file edit flattens its hunks under the first path. The raw per-file data is retained, so this is fixable without recapturing fixtures. |
| OW-5 | deferral | Codex reducer | Reset leaves `tokenUsage`, `threadId`, `turnId` and `unmappedItemTypes` in place. Whether those should survive a reset is unsettled. |
| OW-6 | deferral | Codex reducer | `contextCompaction` is dropped, because the generated item carries no summary. DESIGN's wording says otherwise; one of the two has to change. |
| OW-7 | deferral | Codex reducer | Only the last transcript entry is marked streaming, so an earlier concurrent pending tool call can look complete while it is still running. |
| OW-8 | deferral | Codex adapter | The `thread/resume` response is asserted as `ThreadStartResponse` rather than the generated `ThreadResumeResponse`. |
| OW-9 | deferral | Codex adapter | `setModel` changes outgoing turns, but the reducer's identity may still report the previous model. |
| OW-10 | deferral | Pi process shell | Wrapping a spawn error loses the original stack, `code` and `cause`. The message survives; the identity does not. |
| OW-11 | deferral | transport tests | The offline vertical test does not seed summaries, so it never integrates summary re-keying on `renamed`. |
| OW-12 | deferral | live smoke harness | The abort case fires before the long turn has emitted assistant text, so its "transcript stopped growing" guard has little to bite on. A longer pre-abort wait would strengthen it. |
| OW-13 | deferral | `session-manager.ts` | `disposeAll()` can reach one adapter through both the session table and its startup record, inside a one-microtask window. Correct only because `dispose()` is required to be idempotent (stated on the `BackendAdapter` contract), and not pinned by a test — the interleaving is not reachable deterministically. |
| OW-14 | deferral | `session-manager.ts` | `close()` flags a startup as torn down but leaves the record in `#attaching`, so a re-attach arriving before that startup settles joins it and inherits its rejection — a 404 for a session that is on disk. Transient, and a retry works; the joiner should skip a torn-down record instead. |
| OW-15 | deferral | Pi process shell | A `success:false` response to the post-admission `get_state` probe is swallowed with no diagnostic anywhere: `handleResponse` rejects the caller and returns before the `emitError` fallback. Keeping it off `onError` is right — the turn was admitted and is running — but a *persistent* probe failure leaves the session keyed to its `virtual:` id indefinitely, silently. |
| OW-16 | deferral | both process shells | Nothing reports a child that outlives SIGKILL. Codex's `finishTermination` discards the boolean from `closesWithin`, Pi's now does the same, and the manager swallows dispose rejections — so the one condition DESIGN worried about is the one condition no layer would tell you about. Making `kill()` record or throw on a false return is the fix. |
| OW-17 | question | `resources/codex-protocol/` | Whether to import the generated bindings into `src/` or reference them in place. Either way they stay the source of truth; do not hand-write Codex types. |
| OW-18 | question | Codex approvals (D2a) | **Whether agentpane should set `approvalPolicy` on its threads, and whether doing so (or the sandbox policy) suppresses Codex's approval `ServerRequest`s.** Two coupled parts. (a) *Does anything already suppress them?* app-server may still raise exec/patch approval `ServerRequest`s (the `tool-edit` fixture has a live `item/fileChange/requestApproval`) even on a `danger-full-access` thread (OW-37); unverified. The old framing — that sbox's injected `--sandbox danger-full-access` governs this — was wrong: that CLI flag is a no-op for `app-server` (OW-37), so the effective levers are both per-`thread/start`. (b) *Should we set `approvalPolicy:"never"`?* `approvalPolicy` is an `AskForApproval` field (`resources/codex-protocol/v2/AskForApproval.ts`, includes `"never"`) on both `ThreadStartParams` and `TurnStartParams`, sent by the adapter at the same sites as OW-37's sandbox field (`src/server/adapters/codex/adapter.ts:179-189`, `turn/start` ~line 270); agentpane sends none today, so the thread defaults to `"on-request"` (observed in the OW-37 probe). Given the sandbox flag is a no-op for app-server, the safe prior is that the top-level `--ask-for-approval`/`--approval-mode` CLI flag is too, and only the per-thread `approvalPolicy` bites — but that is the thing to verify, not assume. The decision hinges on D2a: agentpane *does* forward approval requests to the browser, so "never" is a real behavior change (no dialog vs. dialog), not just noise suppression. Verify at the source before deciding: a probe that starts a thread with and without `approvalPolicy:"never"`, drives a turn that edits a file, and records whether a `ServerRequest` reaches the wire (extend `resources/probes/codex_turn_probe.py`, or the sandbox probe from the OW-37 investigation). Settling this leaves this list and becomes a D-decision in `DESIGN.md`. |
| OW-19 | question | renderer | Whether `plan` and `contextCompaction` items deserve bespoke rendering or fold into text. |
| OW-20 | question | `src/server/sessions/` | Whether session listing needs an index cache once the corpus is larger than the ~973 sessions measured for D9 (HANDOFF 19). Both upstreams eventually built one. |
| OW-21 | question | `GET /api/models` | **Where the model list comes from with nothing attached.** `listModels()` exists only on an adapter instance, and verified against the real `PiAdapter`, calling it before `start()` rejects with "Pi process is not running" — the answer lives in the subprocess. So the route reports zero Pi models until a Pi session is open, which is exactly when a new-session model picker needs it. Spawning to answer a *listing* question is what D9 rules out, so the candidates are a backend-level (not session-level) model source, caching the last live answer, or accepting that you pick a model only from an attached session. The route degrades quietly today; it does not fail. |
| OW-22 | question | `POST .../fork` | **What a fork's returned ref means.** Pi's `fork` rewinds the active branch of the *same* session file and returns the same ref; Codex's `thread/fork` mints a new thread id. The route hands that ref straight back, so on Codex the browser will receive a ref for a session the process table has never heard of and holds no adapter for — and the on-disk index may not see a thread the backend has not flushed. Settle it with the Codex adapter, not before. |
| OW-23 | defect | `src/server/composition.ts:14` (`get`), `src/server/sessions/index.ts:82-98` (`listSessions`) | **`SessionIndex.get(ref)` fully parses every session file in both stores on every cold attach.** `get` calls `listSessions()` with no args, which reads and parses the full content of every `.jsonl` file in both stores (line 94) *before* any `cwd` filter is applied (lines 96-98) — so passing a `cwd` filter through, this row's previous fix suggestion, would not help: the filter only trims the array handed to `.find()`, after the expensive walk+parse already happened. `session-manager.ts:286` calls `get` for any session not already in the process table, so every cold attach pays the full-corpus cost — ~0.28s against finding 19's 973-file census, growing with the corpus. **Promoted by D12:** idle/LRU eviction makes cold reattach routine, so this moves onto the hot path — fixing it is a prerequisite to landing OW-33/OW-34, not a follow-up. Real fix, dispatch on `ref.backend` inside `get` instead of delegating to `listSessions`: for Pi, the ref *is* the file path (D9), so `get` should `stat` + `parsePiSession` (`src/server/sessions/pi.ts`) that one file directly, no walk at all. For Codex, the ref's UUID is embedded in the filename (verified against a real file: `~/.codex/sessions/2026/08/12/rollout-2026-08-12T22-10-29-019ff8e2-...-c5.jsonl`) — use `findJsonlFiles` (`src/server/sessions/walk.ts`, a `readdir`-only walk with no file reads) to find the filename match, then `parseCodexSession` only that one file. Done when: a test seeding N session files across both backends, calling `get()` for one Pi ref and one Codex ref, asserts (via a read-call counter or spy on the parse functions) that only the matching file's content is read — not all N — and the existing cold-attach integration test still passes. |
| OW-24 | unverified | whole client | **No automated browser coverage exists.** DESIGN's testing strategy names Playwright E2E driving a real turn; none has been written. Every live check to date ran against REST/SSE, so transcript rendering and tool cards are unproven by any test. |
| OW-25 | unverified | Pi approvals | Whether Pi raises approval dialogs when its `trust.json` does *not* already trust the workspace (HANDOFF finding 42 copies one in, so it shows only that the sandboxed path does not *add* a prompt). |
| OW-29 | defect | `src/client/App.svelte:88` | "New session" is enabled with an empty workspace. Read from source, not yet observed. |
| OW-32 | deferral | `src/server/adapters/codex/mapping.ts` | **The Codex mapping handles item and content types DESIGN's mapping table does not name, so the table reads as a contract it is not.** `mapItem` (line 295) adds `imageGeneration` and `imageView` — both produce output, neither is in `SILENT_ITEM_TYPES` — beyond DESIGN's ten-row table; the content-block switch (line 137) adds `localImage`, `audio`, `localAudio`, `skill`, and `mention` beyond DESIGN's `input_text`/`output_text`/`input_image`. Either DESIGN's table should say it is non-exhaustive (the switch already treats unknown types as `kind:"none"` for exactly the drift D-notes anticipate) or these rows belong in it. None of these seven arms has a reducer test (`reducer.test.ts` covers the DESIGN-named types plus mcp/dynamic/webSearch); read from source 2026-08-12, not verified against a capture. |
| OW-33 | defect | `src/server/http/session-manager.ts` | **Idle-timeout reaper (D12).** A per-session 15-min timer detaches an idle session: `dispose()` + flip to `detached`, summary retained. Idle clock resets on attach, submit, and turn-end. Exempt while `isStreaming`, while holding a pending request (D2a), or while `virtual`/unmaterialized. Stamp recency/activity **on the `ManagedSession` object**, not an id-keyed side map — `#adoptRef` re-keys the object, so an on-object stamp follows the Pi rename; a side map strands it under the `virtual:` id and reintroduces double-spawn. Pin with tests failing-first: streaming survives the reaper, pending-request survives, virtual survives, an idle detached-eligible one is reaped; and a reaped-then-reattached session re-spawns exactly once (no leak). |
| OW-34 | defect | `src/server/http/session-manager.ts` | **LRU subprocess cap N=16 (D12).** At attach, before spawning the 17th subprocess, evict the coldest eligible session (LRU recency = last attach, held on `ManagedSession`), then spawn. Evict via canonical ref (`#lookup`/`canonicalRef`). **All-busy = immediate reject:** if all 16 are exempt, fail the attach with an at-capacity error rather than waiting — deliberately visible. `maxSessions`/`idleTimeoutMs` are named constants at the top of the module (no env, no config file). |
| OW-35 | defect | `src/client/controller.ts` | **Prompting a detached/reaped session must transparently attach-then-submit, so D12 eviction is invisible.** When idle/LRU (OW-33/34) has reaped a session's subprocess, a prompt to it must re-attach before submitting rather than fail. Verify the controller's current behavior first — there is no end-session button in the UI today (nothing calls the `DELETE` route from the client), so this row is only the re-attach path, not any button removal. Constraint for the D12 implementer: keep the `DELETE` route — it is programmatically useful and shutdown-adjacent code relies on it. |
| OW-37 | defect | `src/server/adapters/codex/adapter.ts:179-189` | **Codex threads start `read-only`, so the agent cannot write outside the workspace (e.g. `~/.cache`) even though sbox mounts it rw.** `thread/start`/`thread/resume` send only `cwd`/`model`/`ephemeral` — no sandbox policy — and app-server defaults a thread to `read-only`. sbox's injected `codex --sandbox danger-full-access` (D7) is a **no-op for `app-server`**: verified against codex-cli 0.147.0, a thread started as `codex --sandbox danger-full-access app-server` still reports `sandbox: {type:"readOnly"}`; only the per-`thread/start` `sandbox` field moves it (`"danger-full-access"` → `dangerFullAccess`, `"workspace-write"` → `workspaceWrite`). Fix: send `sandbox: "danger-full-access"` on both `thread/start` and `thread/resume`. `danger-full-access` is the right value because agentpane already runs Codex inside sbox's bwrap jail (D7) — the OS layer is the confinement boundary, and anything narrower re-implements sbox's mount list in a second place that will drift. The field is `SandboxMode` (`resources/codex-protocol/v2/SandboxMode.ts`, a string enum) on both `ThreadStartParams`/`ThreadResumeParams`; re-export it from `src/server/adapters/codex/protocol.ts` beside the existing param exports. Prefer an adapter-construction option (`sandbox?: SandboxMode`, default `danger-full-access`) mirroring `ephemeral`, since the frozen `StartOptions` (`src/server/adapters/types.ts`) has no field for it. Done when: `adapter.test.ts`'s existing `thread/start` and `thread/resume` params assertions expect `sandbox:"danger-full-access"`, shown red before the change and green after. Corrects OW-18 and the premise in `DESIGN.md`/`HANDOFF.md` that the injected CLI flag governs app-server. |

OW-26 through OW-31 came out of the first hand-run of the built client on
2026-08-12. Only OW-26 was observed directly; the rest were read out of the
shell's source in the same session and are marked as such — confirm before
acting. OW-3 is the seventh member of that group and predates it: the
per-keystroke workspace input is a client-shell defect that review had already
recorded as a deferral, and it is not duplicated here.

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
touching the repo, `/author` for writing rows, `/execute` for landing them.
This document holds the work, not the process.
