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
a line: take the next id, never reuse one.

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
| OW-18 | question | Codex approvals (D2a) | Whether sbox's injected `--sandbox danger-full-access` suppresses Codex's approval `ServerRequest`s entirely. |
| OW-19 | question | renderer | Whether `plan` and `contextCompaction` items deserve bespoke rendering or fold into text. |
| OW-20 | question | `src/server/sessions/` | Whether session listing needs an index cache once the corpus is larger than the ~973 sessions measured for D9 (HANDOFF 19). Both upstreams eventually built one. |
| OW-21 | question | `GET /api/models` | **Where the model list comes from with nothing attached.** `listModels()` exists only on an adapter instance, and verified against the real `PiAdapter`, calling it before `start()` rejects with "Pi process is not running" — the answer lives in the subprocess. So the route reports zero Pi models until a Pi session is open, which is exactly when a new-session model picker needs it. Spawning to answer a *listing* question is what D9 rules out, so the candidates are a backend-level (not session-level) model source, caching the last live answer, or accepting that you pick a model only from an attached session. The route degrades quietly today; it does not fail. |
| OW-22 | question | `POST .../fork` | **What a fork's returned ref means.** Pi's `fork` rewinds the active branch of the *same* session file and returns the same ref; Codex's `thread/fork` mints a new thread id. The route hands that ref straight back, so on Codex the browser will receive a ref for a session the process table has never heard of and holds no adapter for — and the on-disk index may not see a thread the backend has not flushed. Settle it with the Codex adapter, not before. |
| OW-23 | deferral | `src/server/composition.ts:14` | **`SessionIndex.get(ref)` walks both stores on every cold attach.** Re-checked 2026-08-12: this row previously said `get` had no implementation and was "integration's first job" — that is stale. It is implemented in `createSessionIndex`, as exactly the "list everything and find" the original note warned against: `listSessions()` with no `cwd` filter, then a linear scan. `session-manager.ts:286` calls it for any session not already in the process table, so a cold attach reads the head of every session file in both stores — ~0.28s against finding 19's 973-file census, growing with the corpus. Cheapest real fix first: the call site knows the workspace, and `listSessions` already takes a `cwd` filter it does not pass. Beyond that, Pi's id *is* the file path, so its `get` can be a direct stat/parse; only Codex's UUID needs a walk or a `thread/list`. **Promoted by D12:** idle/LRU eviction makes cold reattach routine, so this walk moves onto the hot path — fixing it (pass the `cwd` filter) is a prerequisite to landing OW-33/OW-34, not a follow-up. |
| OW-24 | unverified | whole client | **No automated browser coverage exists.** DESIGN's testing strategy names Playwright E2E driving a real turn; none has been written. Every live check to date ran against REST/SSE, so transcript rendering and tool cards are unproven by any test. |
| OW-25 | unverified | Pi approvals | Whether Pi raises approval dialogs when its `trust.json` does *not* already trust the workspace (HANDOFF finding 42 copies one in, so it shows only that the sandboxed path does not *add* a prompt). |
| ~~OW-26~~ | ~~defect~~ | ~~`src/client/app.css:112`~~ | ~~**The prompt box is unreachable, which is what makes the app impractical to hand-test.** `.shell` is a `min-height:100vh` grid with no per-pane scrolling, so a growing conversation extends the document rather than scrolling inside itself, pushing the textarea arbitrarily far below the fold. The conversation needs to be its own scroll region with the masthead and prompt pinned. Observed in a browser, 2026-08-12.~~ **Fixed** in `eb57a81`: `.shell` is now a fixed `100vh` grid with the conversation row as `1fr`, and `.conversation` scrolls internally (`min-height:0; overflow-y:auto`) instead of clipping. Verified in a real (Playwright-driven) browser: with 3000px forced into `.conversation`, `document.scrollHeight` stayed pinned to the viewport and the prompt textarea/Send button stayed visible, where before the fix the page grew past the viewport. Not pinned by an automated test — no browser test harness exists yet (OW-24). |
| ~~OW-27~~ | ~~defect~~ | ~~`src/client/render/Transcript.svelte`~~ | ~~**No autoscroll.** Agreed spec (2026-08-12): on submit, snap the view so the new message sits near the bottom of the viewport (no-op if there's nothing above it yet), and turn on follow mode. While on, the viewport tracks new content growing below the message, pushing it upward, until the first of: a manual scroll, the message reaching the top of the viewport (where it locks — continuing would push it off-screen), or the turn ending. A jump-to-latest affordance shows whenever scrolled up from the bottom, streaming or not, and snaps once without re-arming follow. Follow-mode scroll adjustments fire on message-boundary upserts, same throttle as the markdown re-render. Each session remembers its own scroll position independently across selection switches; a session never opened defaults to the bottom. Fixing OW-26 is a prerequisite (done, `eb57a81`).~~ **Fixed** in `a9a1e44`/`5432585`: follow mode arms only on submit (`armFollow`), tracks the submitted message as an anchor, and caps `scrollTop` at `Math.min(bottom, anchorTop)` — recomputed every reconcile — so it locks flush at the viewport's top instead of chasing `scrollHeight` past it. A jump-to-latest affordance shows whenever scrolled up (streaming or not) and snaps once without re-arming. Pinned by `App.test.ts`, including a regression for a real defect live-browser testing caught that the jsdom suite missed: `isStreaming` commonly still reads false on the upsert(s) that echo the submitted message and the assistant's own placeholder back (D2's cross-event ordering is not guaranteed), which was disarming follow before the assistant ever started — fixed with a per-anchor `hasStreamed` flag, confirmed failing first. Live-verified end-to-end in a real browser (synthetic SSE over a mocked EventSource/fetch): submit-while-scrolled-away re-arms and snaps near bottom; a long response locks the submitted message flush at the top (measured -0.06px in real layout); manual scroll-up shows jump-to-latest, survives further growth, and clicking it snaps once without re-arming. |
| ~~OW-28~~ | ~~defect~~ | ~~`src/client/App.svelte:115`~~ | ~~**No keyboard submit; only the Send button.** The prompt is a `<textarea>` inside a form, and a textarea does not submit a form on Enter; there is no keydown handler either, so every send is a mouse trip to the button. **Decision: Ctrl-Enter submits** (and Cmd-Enter on macOS); plain Enter inserts a newline, since coding prompts are routinely multi-line. Add a keydown handler on the textarea that calls the existing `submitPrompt` path on Ctrl/Cmd-Enter. Read from source, not yet observed.~~ **Fixed** in `71fbac1`: a keydown handler on the prompt textarea calls the existing submit path on Ctrl-Enter or Cmd-Enter; plain Enter is untouched. Pinned by `App.test.ts`, confirmed failing first. |
| OW-29 | defect | `src/client/App.svelte:88` | "New session" is enabled with an empty workspace. Read from source, not yet observed. |
| ~~OW-30~~ | ~~defect~~ | ~~`src/client/App.svelte:92`~~ | ~~**Session list is unreadable at scale.** Agreed spec (2026-08-12), modeled on GitHub's AgentsView: each row shows the preview (truncated), workspace, an ISO timestamp to the second (`updatedAt`), a backend badge (pi/codex), and a streaming indicator when `isStreaming`. Stays sorted by recency across all workspaces; narrowing to one workspace is the future workspace-dropdown item's job, not this row's. Distinguishing two sessions in the same workspace relies on the timestamp plus OW-27's per-session scroll memory — no extra affordance needed. No disconnect/close button — D12's idle reaper covers reclamation; the `DELETE` route stays server-side-only, unexposed in the UI. `.sessions` becomes its own scroll region (independent of masthead/conversation/prompt, same treatment `.conversation` got for OW-26), so scrolling a long list never moves the conversation. Two optional additions, both deferrable: a per-row turn-count badge (stretch — D9's listing deliberately reads only each file's header line for cost; a true count needs a full parse per session, which fights that design, so drop it if it does) and a per-row star toggle, purely client-side ephemeral state for visual scanning in a long list — no persistence, no server sync, no effect on sort or filtering.~~ **Fixed** in `44717cc`/`a625cb0`: each row shows backend, workspace, a second-precision UTC timestamp, and a streaming indicator; the preview truncates to a single line (`white-space:nowrap; text-overflow:ellipsis`); the list sorts client-side by recency; `.sessions` gets OW-26's scroll-containment pattern. No close button — an earlier pass added one against the agreed spec, caught in review and removed before landing. Pinned by `App.test.ts`, confirmed failing first; `.sessions` scroll containment verified live (Playwright): with 40 probe rows, `.sessions.scrollHeight` exceeded its `clientHeight` while the page and Send button stayed put. |
| ~~OW-31~~ | ~~defect~~ | ~~`src/client/App.svelte:103`~~ | ~~**Errors are never dismissed.** Agreed spec (2026-08-12): add a manual dismiss (×) on the error banner. Auto-clear-on-next-action is largely already implicit for `view.error` — most `controller.ts` methods already `publish({ error: null })` at the start of the next action — but the displayed `error` is `view.error ?? selectedSession?.error` (`App.svelte:22`), and nothing ever clears a per-session `error` set by an SSE `error` event (`session-state.ts`'s `case "error"`); today only a manual dismiss would ever clear that half. The dismiss control needs to clear whichever of the two is populated.~~ **Fixed** in `1476cf6`: a "Dismiss error" button clears it (`controller.clearError()`), and a session's persisted turn error is now also cleared on the next successful `submit()`. Pinned by `App.test.ts`, `controller.test.ts`, and `session-state.test.ts`, confirmed failing first. |
| OW-32 | deferral | `src/server/adapters/codex/mapping.ts` | **The Codex mapping handles item and content types DESIGN's mapping table does not name, so the table reads as a contract it is not.** `mapItem` (line 295) adds `imageGeneration` and `imageView` — both produce output, neither is in `SILENT_ITEM_TYPES` — beyond DESIGN's ten-row table; the content-block switch (line 137) adds `localImage`, `audio`, `localAudio`, `skill`, and `mention` beyond DESIGN's `input_text`/`output_text`/`input_image`. Either DESIGN's table should say it is non-exhaustive (the switch already treats unknown types as `kind:"none"` for exactly the drift D-notes anticipate) or these rows belong in it. None of these seven arms has a reducer test (`reducer.test.ts` covers the DESIGN-named types plus mcp/dynamic/webSearch); read from source 2026-08-12, not verified against a capture. |
| OW-33 | defect | `src/server/http/session-manager.ts` | **Idle-timeout reaper (D12).** A per-session 15-min timer detaches an idle session: `dispose()` + flip to `detached`, summary retained. Idle clock resets on attach, submit, and turn-end. Exempt while `isStreaming`, while holding a pending request (D2a), or while `virtual`/unmaterialized. Stamp recency/activity **on the `ManagedSession` object**, not an id-keyed side map — `#adoptRef` re-keys the object, so an on-object stamp follows the Pi rename; a side map strands it under the `virtual:` id and reintroduces double-spawn. Pin with tests failing-first: streaming survives the reaper, pending-request survives, virtual survives, an idle detached-eligible one is reaped; and a reaped-then-reattached session re-spawns exactly once (no leak). |
| OW-34 | defect | `src/server/http/session-manager.ts` | **LRU subprocess cap N=16 (D12).** At attach, before spawning the 17th subprocess, evict the coldest eligible session (LRU recency = last attach, held on `ManagedSession`), then spawn. Evict via canonical ref (`#lookup`/`canonicalRef`). **All-busy = immediate reject:** if all 16 are exempt, fail the attach with an at-capacity error rather than waiting — deliberately visible. `maxSessions`/`idleTimeoutMs` are named constants at the top of the module (no env, no config file). |
| OW-35 | defect | `src/client/controller.ts` | **Prompting a detached/reaped session must transparently attach-then-submit, so D12 eviction is invisible.** When idle/LRU (OW-33/34) has reaped a session's subprocess, a prompt to it must re-attach before submitting rather than fail. Verify the controller's current behavior first — there is no end-session button in the UI today (nothing calls the `DELETE` route from the client), so this row is only the re-attach path, not any button removal. Constraint for the D12 implementer: keep the `DELETE` route — it is programmatically useful and shutdown-adjacent code relies on it. |
| ~~OW-36~~ | ~~defect~~ | ~~`src/client/app.css`~~ | ~~**Shell chrome text is oversized relative to the transcript.** `body`/`.shell` never sets a base `font-size`, so `input, select, textarea, button { font: inherit; }` (`app.css:134`) falls through to the browser's unstyled default rather than the design-token scale — `.transcript` is the only place that explicitly opts into `var(--ap-text-md)`. Observed in a browser, 2026-08-12: the Workspace input, Backend select, "New session" button, and every session-list row all read noticeably larger than the conversation, even though their labels (`.session-controls label`) already correctly use `--ap-text-sm`. Fix: set a base `font-size` on `body` (or `.shell`) from the token scale, so the whole shell inherits it by default rather than patching each element individually.~~ **Fixed** in `db1f66c`: `body` now sets `font-size: var(--ap-text-md)`. Verified live (Playwright): computed font-size on the Workspace input and "New session" button before/after. |

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

## How work gets done (2026-08-12)

Agreed with the repo's owner, and written here because the agreement itself
would otherwise live only in a chat session — the failure mode this document
exists to prevent.

- **Development is serialized.** One thing at a time. No concurrent agents, so
  no row in Open work needs an owner or a claim.
- **Work lands directly on `main`**, committed as the work is done. No feature
  branch, no PR. Small, single-purpose commits, because the commit log is the
  only review surface left — the point is diagnosis later, not rollback.
- **Never `git push`.** Committing is local and freely authorized; publishing
  to `origin` happens only when the owner asks for it, by name.
- **Never commit red.** `bun run check` before any commit touching `src/`
  (~25s). Say so explicitly when a commit is documentation only.
- **Delegation, when it earns its keep.** The loop is: pick the next `OW-` row,
  write it up with success criteria, hand it to a single subagent in its own
  worktree, review the result, land it. Do not dispatch work smaller than the
  cost of a cold agent re-deriving this context — batch small rows, or just do
  them. Choose the model per task: a crisp spec with mechanical verification
  delegates well; work where *writing the spec is the hard part* does not.
- **Success criteria must be observable**, never descriptive. A test that fails
  before the change and passes after, or a screenshot — not "matches the
  description." If the spec is checked only against itself, the spec's blind
  spots survive review intact. `wip/pi-adapter` passed `bun run check` on merge
  holding four real defects; that is the case this rule is aimed at.
- **Closing a row**: strike it in place and append the evidence, the way
  DESIGN's settled question is struck. Ids stay stable and the history stays
  readable:
  `~~**OW-26** ...~~ **Fixed** in <sha>; pinned by <test>, confirmed failing first.`

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
- Evidence from a live run: `MANUAL_TESTING.md`.
- **Anything left undone — a defect, a deferral, a question, an unproven
  claim: a row in Open work above.** One list, one id, cited from elsewhere
  rather than restated. Restating it in a second document is how the Pi
  contradiction happened.
- Project status: the Status table above, and nowhere else.
