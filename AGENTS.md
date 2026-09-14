# agentpane

Decisions D1–D20 in `docs/DESIGN.md`, the evidence behind the work in `docs/HANDOFF.md`.
Work items are cards, in the deck at `docs/work/`, read and written through the `card` CLI — see "Cards" below, and run `card status`.

## Commands

`bun install` first.
Runtime is Bun, tests are vitest.
`bun run check` (svelte-check, which also typechecks the plain `.ts` files, plus all tests) must pass before any commit touching `src/`; say so explicitly when a commit is docs only.
It is kept fast enough to run before every commit -- about 40s on the home server's 4 cores as of 2026-09-11 -- and a run that drifts well past that is a defect to profile, not a reason to skip it.
The `test` script pins `TZ=Asia/Kolkata`, a half-hour-offset zone that makes both the clock and the offset arithmetic visible in time assertions (OW-70); running `vitest` directly, without the pin, fails those tests.

`bun run test:browser` runs the Playwright vehicle in `e2e/` (~30s, headless Chromium).
It is **not** part of `bun run check`, which stays fast and browser-free (OW-49); `.github/workflows/ci.yml` runs it instead as a sibling job on every push to `main` and every pull request targeting it.
That job is a backstop after the push, never a substitute for the local run: run it by hand before committing when you touch follow-mode scrolling in `App.svelte`, `.conversation` in `app.css`, the composer's action row, the message footer rows in `src/client/render/`, or anything under `public/`; jsdom cannot see layout, scroll anchoring, real scroll-event timing, or the Popover API, none of which it implements, and nothing in the module graph imports the favicons at all.

That vehicle cannot report a page as unfocused: it drives `chromium-headless-shell`, which answers `document.hasFocus() === true` everywhere.
`e2e/harness.ts` stubs `document.hasFocus` for that reason, and `docs/MANUAL_TESTING.md` records the levers that were probed and failed.

## Code

- Path aliases `$shared/*`, `$server/*`, `$client/*`.
  Imports carry `.ts`.
- Two test projects: `src/server/**` and `src/shared/**` run in node, `src/client/**` in jsdom.
  Put the file in the right place instead of writing a per-file environment docblock.
- The `@earendil-works/pi-*` packages are types-only (D10).
  `import type` only; `src/import-boundaries.test.ts` fails the build and names your file.
- Assert on structure, never on model wording — fixture text varies per capture.

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
  Pi's own default is weaker than a default that could drift, and the flag is doing more work there than on the other two: as of 2026-09-13 the sandbox mounts `~/.pi/agent` read-only, so Pi cannot take the lock it needs merely to *read* `settings.json`, resolves no model at all, and answers `get_state` with `"id": "unknown"` and `thinkingLevel: "off"` — see `docs/MANUAL_TESTING.md`, "Pi arrives on the home server".
  The pin binds the turns an agent session drives while coding, debugging, or testing, because that work belongs on inexpensive models; it says nothing about agentpane's users, and the owner driving agentpane on the home server may choose any model.
  A reader on 2026-09-08 took it as a property of the machine and proposed restricting the model picker to enforce it; that was never the intent.
- **What is still confined to the work laptop is that machine itself.**
  Live Pi evidence was, until 2026-09-13, the main reason to go there; it no longer is, and a card asking for one belongs wherever the session is.
  What remains is that clone's own provisioning — its `.git/card/` and its PATH, as in OW-gabemi — and the reference material `docs/HANDOFF.md` addresses there by absolute path under "Reference material on the work laptop".
  Such an item carries the label `work-laptop`, and its body still opens with the line `**Work laptop:**` naming what the visit needs.
  The label is the filter: `card list --open --label work-laptop` prints those cards with their headlines, which is the intersection view the old two-command survey could not produce.
  Name the machine rather than writing "here": this file is checked in and read from both clones, so a sentence that resolves against the reader's location is false on one of them.
- **A work-laptop item does all of its work in one visit.**
  The scarce resource is trips, not minutes once you are there, so never rank such an item's contents by urgency or name the half that matters most: that is an excuse to do part of it and come back, and the second question usually costs almost nothing while the CLI is already running.
  The triage hint that would help on any other item is a defect on this one.
  Proposed for OW-yudoni on 2026-08-19 and declined by the owner for exactly this reason.
- Pi fork behavior settled live on the work laptop (2026-08-20, `pi 0.84.2`): forking at a user message is exclusive of that message, while forking during a streaming turn succeeds but abandons the in-flight turn.
  See `docs/MANUAL_TESTING.md` OW-yudoni.
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
  Anything left undone becomes a card.
- Build-slice status lives in the Status table at the top of `docs/WORKSTREAMS.md` and nowhere else.
  That table tracks slices, not cards.

## Cards

Work items are cards.
`card status` reports this repo's deck, `card workflow` is the contract, and `card author` and `card execute` carry the two procedures.
Read those rather than a retelling; what follows is only what card cannot know about this repo.
Run `card workflow` when cards come up in the session, and not before: there is no session-opening question to ask about which of card's procedures this session is going to be, and asking one was a defect.

Card reads this deck through per-clone config that is deliberately not synced: `.git/card/card-config.toml`, exactly three lines — `prefix = "OW"`, `deck = "../../docs/work"` (resolved relative to `.git/card/`), and `public = true`, which stands card's commit-lint gate down and is what keeps citing `OW-` ids in commit subjects legal here.
Writing that file, like installing card or Bun, is the owner's provisioning of a machine, not any session's work.

Do not take formatting from the cards already in the deck.
`card author` sets the body's shape — one sentence per line — and the existing cards are hard-wrapped instead, so a card read for prior art teaches the wrong house style while looking authoritative.
Read those cards for their content and the payload for their form.

### Labels

Card treats labels as opaque strings and cannot know this repo's set.
Every card carries exactly one kind, given to `card new --label`:

- `change` — a deliberate change to behaviour or presentation, including a new feature, that nobody considers broken today.
- `defect` — behaviour observed or read as broken, with no dependency on leaving it that way.
- `deferral` — a finding judged not worth blocking current work on.
- `question` — a decision nobody has made yet; it closes when the decision is recorded where the next reader will look.
- `unverified` — behaviour believed to work but never proven; it closes when durable evidence exists.

Four cross-cutting labels may follow that kind.
`work-laptop` marks work that needs the work laptop itself — that clone's provisioning, or the reference material addressed there by absolute path — as described under "Evidence"; it stopped gating live Pi evidence when the home server got `pi` on 2026-09-13.
`browser-testing` marks work whose done condition needs `bun run test:browser` or a human observation in a real browser; it does not belong on ordinary client work that jsdom can settle.
`card list --open --label browser-testing` is the browser-validation queue.
`emacs` groups the Emacs client work, an ACP shim over the HTTP API driven by `agent-shell`, filed 2026-09-13 as OW-fenobo, OW-basoga, OW-limejo, OW-wawipu and OW-mikuyo; `card list --open --label emacs` is that set, blockers and all.

`now` marks the cards to execute next, and `card list --open --label now` is that queue.
It is the deck's only priority signal: card has no priority axis, and `--ready` cannot serve as one here because nearly every open card is unblocked, so a listing that selects everything selects nothing.
Roughly five cards carry `now` at a time, restocked when it empties; the cost of the label falls on those five rather than on every card written, which is the whole reason it is a label and not a field on all of them.
It rides on top of the kind and overrides it: a `deferral` carrying `now` is deliberate, and says this particular deferral has become worth doing ahead of the queue.
Cards without it are not a backlog awaiting their turn — they are the archive, read by grep when a theme comes up.

### Committing a card you authored

Commit it unless the user asks not to.
Card never commits anything, and its author payload is silent on git.

## Dispatching an implementer

`card worktree <id>` cuts the tree — `.worktrees/<id>`, on branch `card/<id>`, from the branch the main checkout is on.
It therefore starts at local `main`'s tip and there is **nothing to fast-forward**: the `git merge --ff-only main` step the old dispatch procedure carried is gone along with the staleness it existed to fix (`docs/MANUAL_TESTING.md`, "Observed worktree base for dispatched subagents").

`.worktrees/<id>` inside the repo tree is not a preference.
On the home server that tree is the only path mounted read-write, and a worktree anywhere outside it fails with `Read-only file system` (`docs/HANDOFF.md`, "Environment gotchas"); `card worktree` satisfies that by construction.

Three things card cannot know, so the dispatch prompt has to carry them:

- **`bun install` in the fresh worktree** before any `src/` work.
- A dispatched subagent does **not** inherit `CLAUDE.md` or `AGENTS.md`.
  Hand them over: tell it to read them as files in its worktree.
- **From inside a worktree the `card` CLI resolves to the main checkout's deck**, not the worktree's copy, so a deck-mutating verb run there writes outside the implementer's branch entirely.
  An implementer runs the read-only verbs only; filing and closing are the dispatching session's job.

Never `/code-review ultra` in an execution session — it has cost a full budget window.
The old skill's blanket ban on review subagents does *not* survive with it: `card execute` positively requires dispatching an adversarial reader at finished work, and card wins there.
Only the `/code-review ultra` ban is repo-local.
