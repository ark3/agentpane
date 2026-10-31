# Card triage, begun 2026-10-30

A temporary document: it holds the approach steady across compactions and fresh sessions while the owner triages every open card, and the triage's last commit deletes it.

## How this works

The goal is no open card left: whatever still wants doing becomes a GitHub issue on `ark3/agentpane`, usually one issue covering several related cards.
The deck itself is the progress record: a decision is applied the moment the owner makes it, so `card list --open` is always the remaining agenda, and this file never tracks per-card status.
A card folded into an issue closes `card close <id> --promoted`, its note naming `ark3/agentpane#N`; every other card closes `--declined`, `--moot` or `--done` with its reason in the note.
Each round briefs the owner on one group (or a batch of small declines): what each card is about in plain terms, what doing it costs and declining it loses, and a recommendation.
The owner decides, the session applies it, commits, and pushes `main` (the owner allowed pushing for this triage on 2026-10-30, because a cloud container's unpushed commits die with it).

Order agreed on 2026-10-30: the three questions only the owner's use can answer (OW-taweso, OW-yiduso, OW-vaviza), then the declines in batches, then the issue groups from most to least important, and last how work is tracked from here on and the AGENTS.md rewrite that follows from it.

The proposal below was written before any round, and the owner can change any of it; it is the starting grouping, not a record of decisions.
Where a decision departs from it, or does not belong to one card, it goes in the log.

## Decisions log

- 2026-10-31, how issues are written: each issue stands alone for a cold reader, links every card it absorbs at its `docs/work/closed/` path on `main`, and ends with the Claude Code attribution footer.
  Issues are filed unlabelled until the label set is decided at the end, and then labelled in one pass.
- 2026-10-31, round 1 (the three questions from use):
  OW-taweso became ark3/agentpane#3, a test matrix across backend, path and client, since the owner does not remember the details.
  OW-yiduso became ark3/agentpane#4, with the observation at a real browser as its first step.
  OW-vaviza closed `--done`: Ctrl-F not reaching collapsed tool output is wanted, recorded at `built` in `ToolCard.svelte`, and server-backed search is a new issue, ark3/agentpane#5, which no card carried.
- 2026-10-31, round 2 (declines, performance and memory): OW-nitima, OW-luzipe, OW-suyizo, OW-nodade, OW-gipopo and OW-fanopi declined as proposed.
  OW-luzipe's wording fix was done with it: "O(1) per token" is gone from D3 and the three code comments that repeated it.

## The starting proposal

## A. Proposed GitHub issues

### A1. Star and hide sessions, in both clients (D13, D27)

- OW-66  Sessions can be neither starred nor hidden, so the list is stuck with recency and never sheds anything.
- OW-zewiru  The browser can neither star nor hide a session, nor show the server's session-less notice (D13, D27)
- OW-hahuna  agentpane-mode's picker can neither star nor hide a session, nor show the server's session-less notice (D13, D27)

The server store and route come first, then one card per client.
OW-ruyewe (auto-hiding dead forks) is declined below and mentioned in the issue as a later step.

### A2. Mark forks in the session list (D27)

- OW-vezipo  A forked session's row in the list is a character-for-character copy of its parent's, so the two cannot be told apart.
- OW-galuhu  The browser draws a fork's row as a copy of its parent's, with nothing marking the lineage forkedFrom carries (D27)
- OW-kepemu  agentpane-mode's picker draws a fork's row as a copy of its parent's, with nothing marking the lineage forkedFrom carries (D27)

The wire field comes first, then the marker in each client.

### A3. Show Pi and Claude Code session names in the list (D27)

- OW-yilene  Pi and Claude Code session names are read from the store files the walk already opens
- OW-mepivi  The Codex name read at thread/start and at a borrowed fork is pinned by a test

OW-mepivi is one missing test on the Codex name read; it fits naturally here.

### A4. Browser parity with agentpane-mode

- OW-sobutu  The browser can fork only by sending an edited message, where agentpane-mode's f forks at a message and opens the fork with nothing sent
- OW-kokemo  forkAndSubmit resolves to an attach reply its only caller reads as a boolean, and its docblock still justifies the handle for a lookup nothing performs
- OW-zigepi  The browser keeps one composer draft across every session, where each agentpane-mode transcript keeps its own
- OW-homeja  The browser's session list sorts by recency only, where agentpane-mode's picker sorts by its Backend, Status or Updated column

Plain fork, a draft per session, sortable list.
OW-kokemo depends on OW-sobutu's design, so it goes with it.
OW-40 joins this if you say yes (see below).

### A5. agentpane-mode parity with the browser

- OW-radoga  agentpane-mode's new session asks for a backend with no default and takes the calling buffer's project, where the browser's New conversation inherits the selected session's backend and workspace (OW-72)
- OW-sibevo  agentpane-mode draws an image part as an [image <mime>] line, where the browser draws the image itself
- OW-wozoju  agentpane-mode does not mark which user messages are fork points, so a user learns one is not only by pressing f on it (D20)
- OW-yidapi  agentpane-mode's n and p step through every node, with no key that steps between user messages as the browser's rail does
- OW-zudihi  agentpane-mode can copy only the text shr drew for a block, where the browser's Copy takes the block's markdown source
- OW-kafupo  A previewed transcript in agentpane-mode stays as drawn until g, where the browser's preview refreshes itself (OW-76)
- OW-fikuli  agentpane-mode draws neither of the browser's empty-transcript lines, Waiting for the agent… and No messages yet.
- OW-bileva  agentpane-mode's edit says C-RET forks even when the send will first stop a streaming Pi turn, where the browser's button says Stop and fork

Eight small Emacs features from the OW-varevo survey, as a checklist.
Split it if you want them tracked separately.

### A6. Multi-file Codex edits are drawn under the first file's path, in both clients

- OW-4  A multi-file edit flattens its hunks under the first path.

Fully specified, and a fixture exists.

### A7. Pending tool calls are drawn as finished when they are not the last block

- OW-7  Only the last transcript entry is marked streaming, so an earlier concurrent pending tool call can look complete while it is still running.

A real defect on all three backends, in both clients.

### A8. A stopped or interrupted turn does not read as stopped

- OW-nevezo  After a Pi Stop during an auto-retry backoff, the failed attempt stays drawn as a provider error and nothing says the turn was stopped
- OW-yobuyi  An interrupted Codex turn is marked aborted neither live nor in the stored preview, and live it inherits the previous turn's token count

Pi Stop during retry backoff, and an interrupted Codex turn.
Same symptom, different backends.

### A9. The server's waits on Pi are unbounded (Stop behind prompts, compaction mid-turn)

- OW-miguyu  A Pi stop waits out every unanswered prompt's preflight, so an extension command awaiting idle defeats Stop, and client timeouts outrun the waits
- OW-jileku  A Pi compaction holds its session's mutation queue until it ends, and whether a Pi compact sent mid-turn waits for the turn is unmeasured

OW-miguyu names the property; OW-jileku is the same no-timeout exposure plus a live measurement.

### A10. A Pi fork at the first message restores the opening thinking level/model, not the current one

- OW-bupuko  A Pi fork at the first message of a 0.86.0+ session may restore the early model, not the parent's current one

The level half is now confirmed on pi 1.2.0, so this is a real defect; the model half still needs a run.

### A11. Codex stamps every message with the latest turn's model after a restart

- OW-puluki  A Codex assistant message's model comes from one reducer-wide identity at remap time, so a restart restamps every past turn with the last turn's model

### A12. Opening a stored Codex subagent fails on codex-cli 0.157.1

- OW-filasi  Attaching a stored Codex subagent from the picker fails on codex-cli 0.157.1, which refuses thread/resume for a sub-agent whose parent is not loaded

This needs a decision first: resume the parent chain, or refuse with an honest message.

### A13. SessionManager: a failed start's name leaks back; close() edge cases

- OW-giyimu  An attach that joins a virtual session's failed start during its reaping gives the virtual container back the name the failure took, so the stored session under that name is hidden and resolves to the virtual one
- OW-loromi  close()'s reach through names has two edges: a later close can replace an earlier one's #disposing entry, and the closure over a startup's keys can reach a startup of another container when a backend's rename disagrees with the index

OW-giyimu is a probed defect; OW-loromi holds the contrived edges of the same code.

### A14. Codex adapter: dispose resolves before the child closes; preview drops functionCallOutput

- OW-sujizi  A Codex adapter disposed while its own failed start is killing the child resolves before the child has closed
- OW-hejoza  Codex session preview drops a functionCallOutput record, which carries no call_id

First check whether OW-luvema (closed) already made OW-hejoza moot.

### A15. agentpane-mode buffer state across fork, rename and attach

- OW-tukuvo  A fork in flight is held per Emacs buffer, so a sibling buffer on the same session attaches or forks again while it is out
- OW-luwita  A preview still out when agentpane--attach-now attaches its buffer synchronously draws the stored transcript over the live one, since that attach does not supersede it
- OW-tujami  A buffer told its handle is gone, whose ref a rename it never heard and then a close left naming nothing, cannot come back: its attach by the old ref answers 404 for a Pi virtual session
- OW-zulaho  An Emacs edit whose fork lands but whose prompt fails keeps the edit open, where the browser gives its draft back

OW-zulaho is a small decision (match the browser or not) that belongs with this.

### A16. Emacs helper errors are lost or overwritten

- OW-fakefe  With no server listening, jsonrpc's 'Server exited with status 0' overwrites agentpane-mode's 'could not reach the agentpane server' in the echo area of an interactive Emacs
- OW-zugetu  A render that throws in the Emacs helper is contained per node at the flush but nowhere else, and leaves no trace

### A17. Browser behaviour when the server goes away

- OW-pohusi  The browser drops its turn-done badge and follow for a prompt whose POST failed in transport, though the server may have admitted it, where agentpane-mode since OW-hiliti keeps its watch for anything but a refusal
- OW-vipito  A stream retrying against a server that is gone reads the same as a healthy retry

OW-pohusi is a parity defect; OW-vipito is one e2e step that probably proves the problem moot.

### A18. Detect backend wire changes when a CLI is upgraded

- OW-pukado  The fixture censuses are a conformance baseline nothing compares against, so a backend version bump reports no wire changes at all
- OW-wujuda  Five of six Codex fixtures were captured on 0.147.0 against an installed 0.154.0, and nothing has measured whether the wire moved
- OW-jetofe  fork_probe.py's Pi mid-stream cell still predicts 2 messages after the fork, where pi 0.86.0+ answers 3
- OW-wawese  The smoke probes' post-abort growth check takes its baseline when the probe next polls, not at the idle event, so text arriving just after idle is never checked

The census-diff tooling, its first run on Codex, and two probe-fidelity fixes.

### A19. Test-strength gaps at the integration boundaries

- OW-24  No Playwright path crosses the production HTTP/SSE server into the real controller and transcript.
- OW-42  App tests still substitute a non-publishing controller at the re-entrancy boundary where production has already failed once.
- OW-muyawi  The snapshot arm's exemption from the sequence check is contract, but the client suite never replays the wire shape that proves it
- OW-hutaki  Opening a tool card is now two height changes rather than one, and nothing has checked what scroll anchoring does with the second

Production-server e2e, a real-controller App band, two missing assertions, and one scroll-anchoring spec.

### A20. The ERT suite leaks state between tests

- OW-visegi  An ERT test that fails partway through a helper's death leaves its teardown's answers pending, and they land in the next test's captured messages
- OW-zowuji  agentpane-mode's turn-done tests leave their indicator entry in the global global-mode-string for every later test

### A21. bun run check takes ~62s against the documented 40s

- OW-hinohi  bun run check takes about 62s on the home server against the 40s AGENTS.md records, and nobody has profiled where the 22s went

### A22. Work laptop: survey the Pi store there

- OW-furivo  agentpane's Pi store readers have only been checked against the home server's 13 session files, never against the work laptop's store

This is done by hand on the work laptop; the issue keeps the exact commands.

### A23. D12 process limits: idle reaper and subprocess cap

- OW-33  Idle-timeout reaper (D12).
- OW-34  LRU subprocess cap N=16 (D12).

You called these not urgent.
The choice is between keeping them as one issue and declining them; see the questions below.

### A24. Small server cleanups

- OW-geveja  Claude's `toolNames` is a per-turn map that nothing expires
- OW-tijilo  The server repeats small helpers across adapters and session readers: ZERO_USAGE, isRecord, idFromFilename, the Claude store root

A leaking per-turn map and duplicated helpers.
Both are cheap.

## B. Questions for you

- OW-taweso  After a compaction, the transcript shows the context handed to the fresh session as a user message, so it misattributes who said what from then on
**Needs you, now.** The card waits on your description of the compaction symptom: which backends, where it shows (live, after reload, preview), what the text is, and what you expect instead.
  Answer here and I'll turn it into an issue.

- OW-yiduso  Nothing has watched a browser actually repaint the tab icon when the favicon href is swapped.
**Needs you, now.** You use agentpane daily: does the tab icon visibly change when a turn finishes, and is the dot noticeable?
  If yes, I close it `--done` with your observation.

- OW-vaviza  Find-in-page no longer reaches a tool card's output, because OW-lisaye stopped building a collapsed body the browser used to auto-expand into
**Needs you, now.** Does Ctrl-F find text inside a collapsed tool card?
  Either way: accept the loss (I write that into the `built` docblock and close), or file an issue.

- OW-40  No way to start a session in a workspace that has no existing sessions.
**Your call.** Starting a session in a brand-new workspace from the browser.
  You deferred it twice ("do not build without asking"), but agentpane-mode can already do it, so it is now a parity gap.
  If you say build it, it goes into the browser-parity issue; if not, I decline it.

- OW-68  Nothing pushes, so the two clones only converge when the owner moves commits by hand.
**Your call.** "Nothing pushes." Moving to GitHub issues makes pushing matter more (issue links point at files on `main`).
  Either moot (you push now) or decline.

- OW-wawipu  agentpane-created Claude sessions are hidden from the claude --resume picker by their sdk-cli entrypoint, while its Codex sessions show up as vscode
**Your call.** agentpane's Claude sessions are hidden from `claude --resume`'s picker.
  Recommendation: decline unless you care about jumping to the TUI; it is a run plus a doc sentence.

- OW-hilake  The expanded-block dialog claims `aria-modal` without trapping focus, and the streaming and thinking dots label bare spans that screen readers drop
**Your call.** Three accessibility gaps (focus trap, aria on the dots, menu role).
  Recommendation: decline for a single-user tool, unless you want them.

- OW-hipote  `App.svelte` is 1300 lines with no style block and three seams it is not using: the follow engine, the session list, and the composer
**Your call.** Split the 1300-line `App.svelte`.
  Recommendation: decline as tracked work; the card's own advice (do it when a change touches two of the seams) can live as a line in AGENTS.md.

- OW-25  Whether the probes still need to copy Pi's `trust.json`, now that agentpane cancels every Pi dialog at arrival
Recommend `--moot`: every Pi dialog is now cancelled on arrival, so nothing depends on whether the probes copy `trust.json`.

- OW-20  What observation should trigger building an index cache for session listing, given the current answer is a recorded "not yet" rather than an open question.
Recommend `--done`: the question is answered (the trigger is a measured slow `GET /api/sessions`, not corpus size).
  I'd record that sentence in D9 and close.

## C. Close `--declined`

Each is a deferral or unverified worry that nothing has observed.
The close note keeps its reason and what would reopen it.

- OW-ruyewe  Forks pile up in the list as sessions nobody wants back, and nothing hides the kinds of fork that are known dead
Auto-hiding dead forks needs marks first and then real use; the star/hide issue will say so.

- OW-muvili  A session-less Codex app-server, started after the list is already served, collects thread names and models the rollout walk cannot see
You deferred the Codex name collector under D27, and it conflicts with D25's "only an attach starts an agent".

- OW-husuju  A Pi rename the adapter did not send reaches the listing through session_info_changed
Nothing but agentpane renames Pi sessions today.

- OW-hivahe  A Pi fork's session_start notify goes out under the parent's handle before the adapter learns of the move
Nothing visible as of pi 1.2.0.

- OW-kahuni  A turn killed between a tool block's last input_json_delta and its authoritative assistant event now leaves that call's arguments at {}
A one-stream-line window, and the call never ran.

- OW-nitima  Every Codex delta rebuilds the whole transcript array and rescans every slot, which is linear in the transcript per token
Never measured at a length where it shows.

- OW-suyizo  SSE writes have no backpressure, so a stalled tab accumulates whole-transcript snapshots in server memory without bound
Nothing observed; under D25 the fix is no longer free.

- OW-luzipe  D3 calls the tail upsert "O(1) per token", but it re-sends the whole message, so a turn is quadratic in its own length.
Profiling buried this under render cost.
  **But** "O(1) per token" is wrong in 4 places; I'd fix that wording in this session (docs + comments, no behaviour change).

- OW-pazuwi  A command written before a stdin EPIPE waits until close, which never comes if the child keeps running
No backend closes its stdin and stays alive.

- OW-vefofo  The SIGKILL survivor report cannot tell a child that outlived SIGKILL from one that exited while something else still holds its pipes
The report still means something didn't let go.

- OW-henazu  The session walkers skip symlinked files and directories silently
Nobody symlinks their stores.

- OW-nodade  The browser's foldSessionTurns never drops a key the live session map no longer carries, so its streaming and finished tables grow for the life of the tab
Memory only, never drawn.

- OW-didose  The Attach button does not focus the prompt when the attach reply beats its snapshot, since no composer is drawn yet
Rare ordering; costs one click.

- OW-gipopo  agentpane-mode draws a backlog of session/node once per pipe read that holds one, not once for the whole backlog
No lag has been observed since OW-jeruye/OW-tujezi.

- OW-fanopi  The visual-wrap width memo agentpane--insert-html keeps lives for one text part, so a full redraw still measures each list marker once per text part, about 142 calls where one memo per redraw would make 24
About 10 ms per redraw.

- OW-vipiso  agentpane--fit-header measures a header in the selected frame, not the frame whose window it is fitted to, so a transcript shown only on another frame is cut to the wrong width
Multi-frame daemon with differing fonts only.

- OW-dulime  A customised shr-bullet that opens with whitespace, or uses a character outside agentpane's marker set, draws Emacs list rows with no hanging indent
Only with a customised shr-bullet, which nobody uses.

- OW-weboto  A live upsert that changes two nodes, a folded result becoming an orphan or the reverse, reaches Emacs as one, since projectUpsert returns one node
No server path emits the sequence.

- OW-yorita  The condense-side anchor assertion cannot tell a reconcile pin from a bare clamp when the scroller is already at bottom
The dead-toggle case is still caught indirectly.

- OW-bagofa  Nothing catches the perf harness losing its Edit controls again
The card itself offers declining as an outcome.

- OW-wayovu  Neither `CodexConnectionRegistry.forget` call site is individually tested, because the fake app-server exits synchronously inside `kill()`
Test strength only; both call sites read as correct.

- OW-manulu  A rejected thread/compact/start re-raises app-server text unframed
Nothing reaches the path.

- OW-kehose  A generated image renders as `[image: image/png]` -- its mime type and nothing else -- because an assistant message cannot hold an image block, though the same data URL renders as a picture when a user sends it.
Blocked on a capture no account here can produce (the image_gen tool isn't offered).
  Reopen if that changes.

- OW-miwofi  Codex drops the first line of a long-running command output from the wire, so the live transcript starts at line two while the rollout keeps line one
Upstream Codex loss; agentpane cannot fix it.

- OW-tegoje  The Pi session list's one-line preview takes the first user message in the file, which may sit on a branch Pi abandoned
Never seen in a real file; the cost argument stands.
  (Or fold it into the names issue, which reads the file tail anyway.)

## D. Close `--moot`

- OW-12  The abort case fires before the long turn has emitted assistant text, so its "transcript stopped growing" guard has little to bite on.
Overtaken by OW-sofige: the smoke probes now abort twenty thousand characters into the long turn's text.

## E. Left for the end

- Whether GitHub issues replace cards for new work, or cards stay for new work and only this backlog moves; the AGENTS.md "Cards" section is rewritten accordingly.
- The GitHub label set: proposed `defect`, `change`, `question`, plus `browser`, `emacs`, `work-laptop`, `browser-testing`.
  The GitHub tools in a cloud session can attach labels but not create them.
