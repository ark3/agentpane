# agentpane

Decisions D1–D27 in `docs/DESIGN.md`, the evidence behind the work in `docs/HANDOFF.md`.
Outstanding work is tracked in GitHub issues; see "Issues and cards" below.

## Commands

`bun install` first.
Runtime is Bun, tests are vitest.
`bun run check` (svelte-check, which also typechecks the plain `.ts` files, plus all tests) must pass before any commit touching `src/`; say so explicitly when a commit is docs only.
It is kept fast enough to run before every commit -- about 40s on the home server's 4 cores as of 2026-09-11 -- and a run that drifts well past that is a defect to profile, not a reason to skip it.
The `test` script pins `TZ=Asia/Kolkata`, a half-hour-offset zone that makes both the clock and the offset arithmetic visible in time assertions (OW-70); running `vitest` directly, without the pin, fails those tests.

`bun run test:browser` runs the Playwright vehicle in `e2e/` (~30s, headless Chromium).
It is **not** part of `bun run check`, which stays fast and browser-free (OW-49); `.github/workflows/ci.yml` runs it instead as a sibling job on every push to `main` and every pull request targeting it.
That job is a backstop after the push, never a substitute for the local run: run it by hand before committing when you touch follow-mode scrolling in `App.svelte`, `.conversation` or the `.shell` grid in `app.css`, the composer's action row, the message footer rows in `src/client/render/`, or anything under `public/`; jsdom cannot see layout, scroll anchoring, real scroll-event timing, or the Popover API, none of which it implements, and nothing in the module graph imports the favicons at all.

That vehicle cannot report a page as unfocused: it drives `chromium-headless-shell`, which answers `document.hasFocus() === true` everywhere.
`e2e/harness.ts` stubs `document.hasFocus` for that reason, and `docs/MANUAL_TESTING.md` records the levers that were probed and failed.

In a claude.ai cloud container the suite cannot launch as checked in: as of 2026-10-02, `@playwright/test 1.62.1` wanted `chromium_headless_shell-1234` while the container shipped only `-1194` under `/opt/pw-browsers`, and downloading browsers there is not allowed.
Run it through an uncommitted config that spreads `playwright.config.ts` and sets `use.launchOptions.executablePath` to `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` (or whatever build that directory holds then).

## Code

- Path aliases `$shared/*`, `$server/*`, `$client/*`.
  Imports carry `.ts`.
- Two test projects: `src/server/**` and `src/shared/**` run in node, `src/client/**` in jsdom.
  Put the file in the right place instead of writing a per-file environment docblock.
- `src/emacs/**` runs in node too and imports client modules by design: the projection in `src/emacs/nodes.ts` reuses `$client/render/` and `$client/preview.ts`, which are plain TypeScript with no DOM dependency, and vitest picks the environment by the test file's path, not by what it imports.
  The one exception is `$client/render/markdown.ts`, whose DOMPurify needs a window: `src/emacs/render.ts` puts a jsdom one on the global and loads that module by dynamic import after it, and its docblock says why the load goes through `process.getBuiltinModule`.
- The `@earendil-works/pi-*` packages are types-only (D10).
  `import type` only; `src/import-boundaries.test.ts` fails the build and names your file.
- Assert on structure, never on model wording — fixture text varies per capture.
- `src/client/App.svelte` has three seams it does not yet use: the scroll, follow and nav-rail engine, the session list, and the composer.
  Split them out when a change touches two of them at once, never as a drive-by, and keep `$state.raw` on `view` confining re-parsing to the tail block (D5), which `App.streaming-cost.test.ts` and `App.sort-cost.test.ts` measure (OW-hipote, declined as a card 2026-10-31).

## Documentation

Markdown prose uses one sentence per line and never wraps at a column count.
Existing hard-wrapped prose in `README.md`, sections of `docs/MANUAL_TESTING.md` written before 2026-08-27, and `resources/fixtures/README.md` and `resources/probes/README.md` may remain wrapped; new prose and any paragraph substantively edited follow the current rule.

## Evidence

- Verify at the source.
  Where a claim about a CLI, a protocol, or a runtime is load-bearing, reproduce it and record how.
- **A claim about backend behaviour names the version it was measured on.**
  Pi, Codex and Claude Code move forward constantly and this project never rolls back, so present tense without a version is the defect: it reads as current forever and nothing marks the day it stopped being true.
  Write "as of `codex-cli 0.147.0`, app-server defaulted each thread to `read-only`", not "app-server defaults each thread to `read-only`" -- that exact sentence sat three lines from a 0.154.0 measurement in `docs/DESIGN.md` and still read as present fact.
  This is not an obligation to keep claims current.
  D18 sorts backend facts by what their going stale costs and defends only the ones that license code nobody wrote; the rest are allowed to age and are corrected when someone trips on them.
- **All three CLIs run on the home server, each pinned to one model.**
  Claude Code on Haiku (OW-yilabe, OW-beripo), Codex on Luna, and — since the owner installed `pi 0.85.1` there on 2026-09-13 — Pi on DeepSeek V4.1 Flash.
  Do not trust the machine's defaults to enforce it: as of 2026-09-09 the home server's `~/.claude/settings.json` selects `sonnet` and its `~/.codex/config.toml` happens to select `gpt-5.6-luna`, and either can change — so the flag is the whole of the constraint and is never optional: `claude --model haiku`, `codex -m gpt-5.6-luna`, `pi --model openrouter/deepseek/deepseek-v4.1-flash:high`.
  Pi reads its own default from `~/.pi/agent/settings.json`, which the owner may edit at any time — measured there on 2026-09-13, after the sandbox was widened to mount that directory read-write, `get_state` reported `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"` both directly and through `sbox` (`docs/MANUAL_TESTING.md`, "Pi arrives on the home server").
  Earlier that same day the directory was read-only, and Pi — unable to take the lock it needs merely to *read* that file — resolved no model at all, answering `get_state` with `"id": "unknown"`.
  That is the failure the flag exists to make impossible, and it is why the flag stays mandatory even where the file is readable.
  The pin binds the turns an agent session drives while coding, debugging, or testing, because that work belongs on inexpensive models; it says nothing about agentpane's users, and the owner driving agentpane on the home server may choose any model.
  A reader on 2026-09-08 took it as a property of the machine and proposed restricting the model picker to enforce it; that was never the intent.
- **Do not assume how your session was launched.**
  A card may be executed by Claude Code, Codex or Pi, by hand or as a `card` role session, under whatever sandbox that launch builds, and what is writable differs between them: on 2026-10-14 a `card run` session, started as plain `sbox claude`, found `~/.pi/agent` read-only, while an interactive session on the same machine could write it (OW-robozi).
  Driving a backend CLI directly against its own state directory is fine for development on the home server, and is the first thing to try.
  When the state directory is not writable, the CLI says so, if quietly: Pi refuses a prompt with `EROFS ... auth.json.lock` or answers `get_state` with model `"id": "unknown"`, and Codex fails with `failed to initialize sqlite state runtime` (`docs/HANDOFF.md`, "Each backend needs a writable state directory").
  Then give that run a throwaway state directory, as every probe in `resources/probes/` already does: `PI_CODING_AGENT_DIR` or `CODEX_HOME` pointed at a fresh private temp directory holding the credential and settings files copied in by name, and removed when the run ends (`make_state_home` in `resources/probes/capture_fixtures.py`).
  A nested `sbox` cannot make writable what the session's own sandbox mounted read-only, so a run through agentpane's own spawn chain needs the variable in the server's environment, as `resources/probes/agentpane_pi_smoke.py` passes it.
  Say which of the two a run used beside the evidence it produced.
  `agentpane_pi_smoke.py` passed with `--tool-check` in a `card run` session whose `~/.pi/agent` refused a `touch`, on `pi 1.2.0` on 2026-10-14 (`docs/MANUAL_TESTING.md`, OW-fitopi).
- **What is still confined to the work laptop is that machine itself.**
  Live Pi evidence was, until 2026-09-13, the main reason to go there; it no longer is, and an issue asking for one belongs wherever the session is.
  What remains is that clone's own provisioning, as in OW-gabemi, the reference material `docs/HANDOFF.md` addresses there by absolute path under "Reference material on the work laptop", and that machine's own session stores, where the owner uses agentpane daily and which therefore hold the most real use (OW-furivo).
  Such an issue's title opens `Work laptop:`.
  Since 2026-10-14 no agent session develops agentpane on the work laptop: work is planned and executed on the home server, and a work-laptop item is one the owner carries out by hand, so its body names the exact commands to run and what to bring back, and anything that needs an agent — writing a probe, filing issues from the result — happens on the home server before or after the visit.
  The owner updates every CLI to its latest release on both machines each morning, so as of 2026-10-14 a version measured on the home server is the version the work laptop runs that day.
  Name the machine rather than writing "here": this file is checked in and read from both clones, so a sentence that resolves against the reader's location is false on one of them.
- **A work-laptop item does all of its work in one visit.**
  The scarce resource is trips, not minutes once you are there, so never rank such an item's contents by urgency or name the half that matters most: that is an excuse to do part of it and come back, and the second question usually costs almost nothing while the CLI is already running.
  The triage hint that would help on any other item is a defect on this one.
  Proposed for OW-yudoni on 2026-08-19 and declined by the owner for exactly this reason.
- Pi fork behaviour, first measured on the work laptop (2026-08-20, `pi 0.84.2`) and re-measured on the home server twice on 2026-09-15 (`pi 0.85.1`) and twice on 2026-10-14 (`pi 1.2.0`), on `deepseek/deepseek-v4.1-flash`: forking at a user message is exclusive of that message, and forking during a streaming turn succeeds while the turn stops — `isStreaming` goes false and `agent_settled` arrives.
  Streamed text is **not** discarded: on the second 0.85.1 run, with the probe cell holding the fork until forty `text_delta`s had accumulated and re-reading the count at the instant the request went out, 47 deltas were on the wire and the file the turn was streaming into held the reply's first 447 characters (OW-sededi), and the two 1.2.0 runs read 55 and 53 deltas and 551 and 519 characters (OW-vijine).
  So what the fork costs is the rest of the reply and the branch it was on, not the bytes already written.
  The empty assistant entry the first 0.85.1 run read in that file was a fork that landed about 2.2s in, before any text existed; that run gated on `agent_start` alone and could not tell the two apart, and the 0.84.2 run earned even less — it forked at the first user message, where exclusivity empties the new branch whatever became of the turn, and never opened the streamed-into file.
  The 0.85.1 and 1.2.0 runs also read the fork's moved-to session file as already on disk when `fork` returned, carrying the rewound prefix — samples at the instrument that had once read `false`, and all of them forks at the second user message.
  A fork at the first user message keeps no user or assistant message, and on `pi 1.2.0` its file was not on disk when `fork` returned and was written with the branch's first user message (OW-tigaye).
  As of `pi 0.87.1`, and in three runs on `pi 1.2.0`, the abandoned turn's last events, `agent_settled` among them, all arrived before the `fork` response, and nothing arrived between it and the `get_messages` answer that followed (OW-dutute), which is why `hydrateMessages` may replace the transcript.
  See `docs/MANUAL_TESTING.md` OW-sededi, OW-gajesu and OW-vijine, and OW-yudoni for what the earliest run did and did not show.
- Claude Code mid-turn handling settled live on the home server (2026-09-10, `claude 2.1.267`, explicit `--model haiku`): a stream-json user message written during a turn is acknowledged only after the first `result` and runs as a second turn, while a `steer` control request errors as unsupported.
  The adapter therefore rejects `submit()` and `/compact` while a turn is active; see `docs/MANUAL_TESTING.md` OW-jihete.
- Claude Code mid-stream fork behaviour settled live on the home server (2026-09-11, `claude 2.1.268`, explicit `--model haiku`): sampled at four marks spanning 41 to 160 text deltas and again at `result`, the parent's store gains no assistant content until after the turn ends, so a kill mid-turn loses all of it — but the parent turn itself survives a fork spawned as a second child and writes its whole reply durably.
  The loss is agentpane's kill, not the CLI's; see `docs/MANUAL_TESTING.md` OW-japuzo.
- A test that has never failed has not been shown to test anything.
  For a fix, break it again and watch it go red first.
- When a run overturns a fact the repo already recorded, the same change retires **every** copy of it.
  Grep the flag name or the phrase; the copies are not all in docs.
  On 2026-08-20 a run flipped `moved_file_on_disk_at_fork` and left the old answer standing in `docs/MANUAL_TESTING.md`, in the conclusion that section had drawn from it, and in the `pi/process.ts` docblock a reader meets at the code (034d7dd).
  A correction filed one section below the claim it corrects reaches nobody who was not already reading it.
- State the why only where there is a body behind it: an incident that happened or a default the reader will actually follow.
  Refuting something nobody would have tried costs the budget twice — it argues with no one, and it plants the bad move next to the instruction.

## Landing work

- The session agent commits directly on `main` as the work is done, small and single-purpose.
  No branch, no PR.
  A dispatched subagent that writes cannot — it is on its own worktree's branch, so it commits there and the session agent cherry-picks that onto `main`.
  Never `git push` unless asked by name.
- Where a finding goes.
  A doc defect: fix the doc in the same change.
  A fact you verified: the commit message, or `docs/DESIGN.md` if it changes a decision.
  Live-run evidence: `docs/MANUAL_TESTING.md`.
- Build-slice status lives in the Status table at the top of `docs/WORKSTREAMS.md` and nowhere else.
  That table tracks slices, not issues.

## Issues and cards

Outstanding work is tracked in GitHub issues on `ark3/agentpane`.
Issues say what is to be done; they are not the record of what was decided, which lives in the repo's documents -- decisions in `docs/DESIGN.md`, live-run evidence in `docs/MANUAL_TESTING.md`.
An issue is worked as a plan through `card`, whose deck is ephemeral and lives under `.git`; `card` delivers its own procedure, and `deck agent-help` gives the deck's conventions.
A claude.ai cloud container starts without `card` and is thrown away; install it there with `bun install -g github:ark3/card`, which delivers both `card` and `deck` (card's `BRIEF.md`, as of 2026-11-13).
`OW-` ids name legacy cards, retired on 2026-11-13; `docs/work/README.md` says how to read them.

### Both clients

The Emacs client is first-class and stays at feature parity with the browser; set by the owner on 2026-09-23.
A change that adds or changes a user-facing capability lands it in both clients or in neither.
One that lands it in neither carries the capability onto both wires -- the HTTP API and the Emacs helper's JSON-RPC in `src/emacs/protocol.ts` -- and each client gets its own issue.

## Worktrees

On the home server the repo tree is the only path mounted read-write, so a worktree must sit under `.worktrees/` inside it; anywhere else fails with `Read-only file system` (`docs/HANDOFF.md`, "Environment gotchas").
`card` puts its plan worktree there by construction.

A fresh worktree needs `bun install` before any `src/` work.

Never `/code-review ultra` in an execution session -- it has cost a full budget window.
