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
| client-shell | **offline verified, and hand-tested live in a browser** (open: OW-24, OW-42, OW-48, OW-49, OW-56) | main |

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

## Open work

**Everything outstanding lives here**, in one list with stable ids. Before this
was consolidated the same items were spread across three documents — this
file's deferrals, DESIGN's "Remaining open questions", and MANUAL_TESTING's
"Still unverified" — and drifted, in one case into a flat self-contradiction
about whether Pi had been run live. Other documents now cite an `OW-` id
instead of restating the item.

Five kinds share the list, because they share a lifecycle:

- **deferral** — review found it, judged it not worth blocking on. None is a
  defect in a path the milestone exercises.
- **defect** — observed or read as broken, and nothing depends on leaving it
  that way. The client-shell rows are all of this kind.
- **question** — a decision nobody has made yet. When one settles it leaves
  this list and becomes a decision in `DESIGN.md`, which is where the reasoning
  belongs.
- **unverified** — believed to work, never proven. Closing one means producing
  evidence, and the evidence goes in `MANUAL_TESTING.md`.
- **change** — a deliberate change to behaviour or presentation that nobody
  considers broken today. Decided, not yet built; the decision and who took it
  belong in the row, because there is no defect to rediscover it from.

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
| OW-24 | unverified | whole client | **No automated browser coverage exists.** DESIGN's testing strategy names Playwright E2E driving a real turn; none has been written. Every live check to date ran against REST/SSE, so transcript rendering and tool cards are unproven by any test. |
| OW-25 | unverified | Pi approvals | Whether Pi raises approval dialogs when its `trust.json` does *not* already trust the workspace (HANDOFF finding 42 copies one in, so it shows only that the sandboxed path does not *add* a prompt). |
| OW-32 | deferral | `src/server/adapters/codex/mapping.ts` | **The Codex mapping handles item and content types DESIGN's mapping table does not name, so the table reads as a contract it is not.** `mapItem` (line 295) adds `imageGeneration` and `imageView` — both produce output, neither is in `SILENT_ITEM_TYPES` — beyond DESIGN's ten-row table; the content-block switch (line 137) adds `localImage`, `audio`, `localAudio`, `skill`, and `mention` beyond DESIGN's `input_text`/`output_text`/`input_image`. Either DESIGN's table should say it is non-exhaustive (the switch already treats unknown types as `kind:"none"` for exactly the drift D-notes anticipate) or these rows belong in it. None of these seven arms has a reducer test (`reducer.test.ts` covers the DESIGN-named types plus mcp/dynamic/webSearch); read from source 2026-08-12, not verified against a capture. |
| OW-33 | defect | `src/server/http/session-manager.ts` | **Idle-timeout reaper (D12).** A per-session 15-min timer detaches an idle session: `dispose()` + flip to `detached`, summary retained. Idle clock resets on attach, submit, and turn-end. Exempt while `isStreaming`, while holding a pending request (D2a), or while `virtual`/unmaterialized. Stamp recency/activity **on the `ManagedSession` object**, not an id-keyed side map — `#adoptRef` re-keys the object, so an on-object stamp follows the Pi rename; a side map strands it under the `virtual:` id and reintroduces double-spawn. Pin with tests failing-first: streaming survives the reaper, pending-request survives, virtual survives, an idle detached-eligible one is reaped; and a reaped-then-reattached session re-spawns exactly once (no leak). **Why D12 exists, and why it is not urgent** (project owner, 2026-08-15): the idle reaper and the LRU cap are the answer to a proposed *detach button* — managing subprocess lifetime by hand is the thing D12 refuses, which is why no such button exists and why OW-35 makes eviction invisible. But the pressure it relieves does not currently arise: the app is restarted often while it is being worked on, so attached sessions never pile up. Treat OW-33/34/35 as decided design that has not yet had to pay off, not as a fire. |
| OW-34 | defect | `src/server/http/session-manager.ts` | **LRU subprocess cap N=16 (D12).** At attach, before spawning the 17th subprocess, evict the coldest eligible session (LRU recency = last attach, held on `ManagedSession`), then spawn. Evict via canonical ref (`#lookup`/`canonicalRef`). **All-busy = immediate reject:** if all 16 are exempt, fail the attach with an at-capacity error rather than waiting — deliberately visible. `maxSessions`/`idleTimeoutMs` are named constants at the top of the module (no env, no config file). |
| OW-35 | defect | `src/client/controller.ts` | **Prompting a detached/reaped session must transparently attach-then-submit, so D12 eviction is invisible.** When idle/LRU (OW-33/34) has reaped a session's subprocess, a prompt to it must re-attach before submitting rather than fail. Verify the controller's current behavior first — there is no end-session button in the UI today (nothing calls the `DELETE` route from the client), so this row is only the re-attach path, not any button removal. Constraint for the D12 implementer: keep the `DELETE` route — it is programmatically useful and shutdown-adjacent code relies on it. |
| OW-40 | deferral | `src/client/App.svelte` | **No way to start a session in a workspace that has no existing sessions.** OW-39 replaced the free-form workspace input with a dropdown derived from the listed sessions, and `New session` inherits the selected session's cwd — so a brand-new workspace path can no longer be typed, and on an empty corpus `New session` is disabled with no way to create the first session at all. **Deprioritized to a deferral, by the project owner on 2026-08-14: the workaround is to run `pi` or `codex` from the command line once in the new directory, after which it appears in the dropdown like any other.** Do not build an affordance for this without asking. Two corrections to the original row, both checked at the source, kept only so a future revisit does not repeat the work: (1) its constraint "must not reintroduce OW-3's per-keystroke enumeration" is **misdirected** — OW-3's enumeration lived in `setWorkspace`, which OW-39 deleted outright, and filtering is now purely client-side over `sortedSummaries` (`App.svelte:86-88`); a path input feeding only `controller.create` contacts the server once, on click, so plain text entry is not the hazard the row implied. (2) Whatever affordance is ever added must also close a server-side gap it would make reachable: `POST /api/sessions` (`app.ts:165-170`) validates `cwd` as a non-empty string and nothing more — despite its own error text reading "must be an absolute path" — then `createVirtual` stores it unchecked and it reaches `spawn(..., { cwd })` (`pi/process.ts:157`) only at first attach, so a typo or relative path would return `201 Created` and surface as a spawn failure much later. That gap is unreachable today precisely because `cwd` is always inherited from a listed session. Surfaced in review of OW-39; read from the resulting UI, not observed live. |
| OW-42 | defect | `src/client/App.test.ts`, `src/client/controller.ts` | **`FakeController` does not publish the way the real controller does, so re-entrancy bugs pass its tests.** OW-41 closed this gap for `preview` only, by way of `PublishingPreviewController`; `create`, `select` and `abort` still diverge from `controller.ts` on when they publish, so the same class of defect can still land green. Separately, `controller.preview`'s synchronous `publish({ error: null })` before the `await` is a standing hazard for any future effect keyed off `state.selected` — OW-41 converged around it rather than changing it, because clearing the error only on resolve changes when a stale error leaves the UI. Decide whether to make the fakes publish like the real controller across the board, or to reorder that publish. Related: OW-24 (no browser or integration test through the real controller) is the other half of why OW-41 went unobserved. Surfaced while landing OW-41; not independently reproduced beyond `preview`. |
| OW-48 | deferral | `src/client/App.svelte:61,178-187,246-260` | **`suppressScrollHandling` is a boolean where the thing it guards can happen twice in one frame.** `applyScrollTop` arms it (`:185`) and `handleConversationScroll` consumes it (`:247-248`), but scroll events dispatch asynchronously, so two programmatic scrolls to *different* values landing before the first event arrives produce two events against one flag — the second reads as a user scroll and disengages follow for that turn. Two callers can assign in one frame: the frame-coalesced message effect (`scheduleFollow`) and the unthrottled `ResizeObserver` (`:150-155`). The no-op guard at `:184` closes the identical-value case only. This was candidate (a) of OW-47 and is **not** what caused it; a counter-based guard was written while chasing OW-47, measured to change no outcome, and reverted rather than landed speculatively. So the race is read from the source and remains **unproven** — nobody has produced an interleaving that trips it, and with `overflow-anchor: none` now removing the browser's own scrolls, the remaining pressure on it is lower. Confirm it can actually happen before fixing it; if it can, the fix is a counter rather than a boolean. Surfaced while landing OW-47. |
| OW-49 | deferral | `package.json`, `e2e/` | **The only test pinning OW-47 never runs unless someone remembers to run it.** `bun run test:browser` (Playwright, ~30s, headless Chromium) is deliberately outside `bun run check`, which must stay fast and browser-free — so the follow-mode pin can rot silently and `bun run check` will stay green while it does. `AGENTS.md` now says to run it by hand when touching follow-mode scrolling in `App.svelte` or `.conversation` in `app.css`, which is a convention, not a gate. Options, none chosen: a second `check:browser` script that CI (if there ever is one) runs; folding it in behind an env flag; or accepting the convention and leaving it. Entangled with OW-24 — whoever builds the real browser E2E suite inherits this question and should settle it there rather than separately. Surfaced while landing OW-47. |
| OW-56 | unverified | `e2e/`, `src/client/render/transcript.ts` | **Toggling reading view while follow mode is armed is not covered in a browser.** OW-51 preserves original entry indices precisely so the `[data-index]` anchor survives condensing, and that is pinned by a unit test — but the *interaction* is not: toggling changes content height by a lot while follow can be armed, and jsdom sees neither layout nor real scroll-event timing, which is the whole reason `e2e/` exists (OW-47). `bun run test:browser` was run and passes, but `e2e/follow.spec.ts` only drives follow mode; it never touches the toggle. No defect is claimed — this is untested surface, not an observed break. Whoever builds the real browser suite (OW-24) should cover it there rather than bolting a second spec onto the OW-47 vehicle. Second, smaller gap from the same change: a transcript containing *only* tool results condenses to zero entries and falls through to "No messages yet", which is wrong but needs a slice that starts mid-turn with no prose at all to reach; the executing agent judged it not worth code and this row records that judgement rather than reversing it. Surfaced while landing OW-51. |
| OW-55 | unverified | `src/client/render/Thinking.svelte:58-59` | **The collapsed thinking summary was being laid out by a global rule that no longer exists, and nobody has looked at it since.** Its one-line summary span carries `class="preview"`, which until `f7aa3ae` also matched `app.css`'s global `.preview` rule for preview turns — so the span was getting `display:flex`, `flex-direction:column`, `gap:--ap-space-5` and `--ap-space-5/-4` padding it never asked for, which is also why its own scoped `text-overflow: ellipsis` (which needs a block/inline-block box) could not have been doing anything. OW-50 deleted that rule, so the span now lays out under its scoped rule alone. Read from the cascade, **not observed in a browser either before or after**; the claim that it now ellipsizes correctly is unproven. Closing this means looking at a collapsed thinking block with a long summary and recording what it does in `MANUAL_TESTING.md`. If it still looks wrong, the class name is the cheap fix — `preview` is doing double duty across two unrelated features. Surfaced while landing OW-50. |
| OW-54 | question | `docs/TRACKING.md` | **Whether to replace this table with one-file-per-row storage.** Sketched in `docs/TRACKING.md` — the measurements behind it, the Maildir-shaped design, and the open questions. Not restated here; read the doc. **Format only:** the tool surface was split out to OW-59 on 2026-08-16 because the two decide independently and the format collects most of the measured cost win without a line of tooling written — closing becomes `git mv` plus an append. The doc's "Staying greppable" constraints are load-bearing for that split and are the part to implement literally: a one-line `# `-prefixed headline that never wraps, one-line flat frontmatter scalars, `##` for body subheadings, and list commands that pin their own order with `sort -V` rather than trusting `grep`'s — all three measured against a prototype, and the third because an agent shell's `grep` is a ugrep shim that searches in parallel and reorders between runs. Settling this means a `D` decision in `DESIGN.md` and a rewrite of `AGENTS.md` and both skills. A separate project from the agent UI that happens to live in this repo, so it competes with nothing on this list. Do not act on the doc without the owner saying so. |
| OW-57 | defect | `.claude/skills/execute/SKILL.md:26-33`, `AGENTS.md` "Landing work" | **A dispatched subagent is told to commit somewhere it cannot, so it commits nothing and the parent retypes its diff onto `main` by hand.** Step 2 sends it into its own worktree and opens by telling it to read `CLAUDE.md`, which leads to `AGENTS.md`: *"Commit directly on `main` as the work is done... No branch, no PR."* That instruction is unexecutable from a worktree checked out on a branch that is not `main`, so the safe reading is to leave everything uncommitted — which is what happens. The branches never advance past their starting commit, and step 4 "Land" is really the parent re-applying a diff: `git log --merges` shows nothing since the `OW-` era began, and the close notes say it outright (OW-43, OW-45: *"the patch applied cleanly and `bun run check` was re-run on `main`"*). Nine worktrees accumulated in this checkout before being removed by hand at the owner's request, every one of them holding work that had already landed by other means. Fix both halves: give the dispatch prompt an explicit instruction to commit on its own branch, and scope `AGENTS.md`'s rule so it reads as addressed to the session agent rather than to everything that loads it — otherwise the next dispatched agent hits the same contradiction. Then step 4 becomes `git cherry-pick`, `git commit --amend` for whatever review changed, `bun run check`, `git worktree remove`, `git branch -D`. **Load-bearing:** the amend, because step 3 review deletes out-of-scope work and a bare cherry-pick would land the unreviewed version; and cherry-pick rather than `git merge`, because history on `main` is linear and a merge commit per row breaks that. **Incidental:** whether the worktree is torn down before or after the close commit. Note this does not by itself fix OW-58 — it converts a stale worktree from a paragraph of explanation into a cherry-pick conflict, which is an improvement but a different one. Done when an execute session lands a row this way and its close note carries the cherry-picked sha, with `git worktree list` and `git branch` each showing only `main` when the session ends. Raised by a second agent reviewing the workflow, 2026-08-16. |
| OW-58 | defect | `.claude/skills/execute/SKILL.md:26-28`, OW-43 and OW-45 close notes in `docs/CLOSED.md` | **Dispatch has no freshness step, and worktrees have twice been cut behind `main`.** OW-45's close note says the worktree was *"cut two commits behind `main`"*, OW-43's that it was *"cut behind `main`"*; both were handled by re-running `bun run check` on `main` and explaining the gap in prose, which is bookkeeping standing in for a fix. **Verify the mechanism before designing one:** the Agent tool's `isolation: "worktree"` does not document which commit it branches from, and nobody has checked whether it uses the parent session's start HEAD, the repo HEAD at spawn, or something else. The answer can invert the fix — if it already cuts from HEAD at spawn, then the staleness came from elsewhere (the parent session holding a stale HEAD is the obvious candidate) and adding a rebase at dispatch would be treating a symptom while the cause keeps producing new ones. Cheapest measurement: land a commit, then dispatch a throwaway worktree subagent that reports `git rev-parse HEAD` and nothing else, and compare it to `main`'s tip. Done when that comparison is recorded in `MANUAL_TESTING.md` as live-run evidence, and *either* the dispatch step gains an explicit cut-from-current-tip instruction *or* this row closes on the measurement showing the harness already does it and naming what actually caused the two stale runs. Lower urgency if OW-57 lands first, since staleness stops being silent, but not closed by it. Raised by a second agent reviewing the workflow, 2026-08-16. |
| OW-59 | question | `docs/TRACKING.md` "Tooling, which is a separate item" | **Whether to build the `ow` tool, which of its subcommands earn their keep, or take beads' CLI instead — deliberately not decided until OW-54's storage has been lived with.** Split from OW-54 on 2026-08-16: format and tooling choose independently, and bundling them meant judging what to automate before there was any experience of the storage to judge from. The four sketched subcommands (`new`, `close`, `list`, `check`) are a guess at the surface, and this project's habit is to take a rough cut and get a verdict from using it, which this row exists to make possible. Beads is the option that couples the two axes again — adopting it settles both — so if OW-54 goes that way this row dissolves rather than closing. **Blocked on OW-54 landing, and then on running without the tool long enough to say which absence actually hurt.** The named interim cost is that `ow list` is what replaces the scannable table, so until it exists there is no single view of open work; `ls docs/work/open/` and `grep` stand in, or a generated index stays committed and is deleted when `ow list` arrives. Done when each subcommand is either written or recorded as not wanted, with the reason being something observed during that interim rather than predicted here. |

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
