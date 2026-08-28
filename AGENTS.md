# agentpane

Decisions D1–D14 in `docs/DESIGN.md`, the evidence behind the work in
`docs/HANDOFF.md`. Work items are cards, in the deck at `docs/work/`, read and
written through the `card` CLI — see "Cards" below, and run `card status`.

## Commands

`bun install` first. Runtime is Bun, tests are vitest. `bun run check`
(typecheck + svelte-check + all tests, ~25s) must pass before any commit
touching `src/`; say so explicitly when a commit is docs only.

`bun run test:browser` runs the Playwright vehicle in `e2e/` (~30s, headless
Chromium). It is **not** part of `bun run check` — it needs a browser, so
nothing runs it for you (OW-49). Run it by hand when you touch follow-mode
scrolling in `App.svelte`, `.conversation` in `app.css`, the composer's action
row, the message footer rows in `src/client/render/`, or anything under
`public/`; jsdom cannot see layout, scroll anchoring, real scroll-event timing,
or the Popover API, none of which it implements, and nothing in the module
graph imports the favicons at all.

That vehicle cannot report a page as unfocused: it drives
`chromium-headless-shell`, which answers `document.hasFocus() === true`
everywhere. `e2e/harness.ts` stubs `document.hasFocus` for that reason, and
`docs/MANUAL_TESTING.md` records the levers that were probed and failed.

## Code

- Path aliases `$shared/*`, `$server/*`, `$client/*`. Imports carry `.ts`.
- Two test projects: `src/server/**` and `src/shared/**` run in node,
  `src/client/**` in jsdom. Put the file in the right place instead of writing
  a per-file environment docblock.
- The `@earendil-works/pi-*` packages are types-only (D10). `import type` only;
  `src/import-boundaries.test.ts` fails the build and names your file.
- Assert on structure, never on model wording — fixture text varies per capture.

## Evidence

- Verify at the source. Where a claim about a CLI, a protocol, or a runtime is
  load-bearing, reproduce it and record how.
- **Neither Pi nor Codex runs on the home server.** It has no `pi` at all, and
  while Codex is installed there, running it is expensive enough that it is not
  to be run without being asked. (Claude Code is the exception: it is installed
  on the home server, and live turns there have been authorized on Haiku only —
  OW-yilabe, OW-beripo.) Pi and Codex both run on the work laptop, which is why
  an item whose evidence has to come from a live turn belongs there. Such an
  item carries the label `work-laptop`, and its body still opens with the line
  `**Work laptop:**` naming which CLI the visit needs. The label is the filter:
  `card list --open --label work-laptop` prints those cards with their
  headlines, which is the intersection view the old two-command survey could
  not produce. Reading a captured fixture under `resources/fixtures/` is not a
  live run and is fine on either. Name the machine rather than writing "here":
  this file is checked in and read from both clones, so a sentence that
  resolves against the reader's location is false on one of them.
- **A work-laptop item does all of its work in one visit.** The scarce resource
  is trips, not minutes once you are there, so never rank such an item's
  contents by urgency or name the half that matters most: that is an excuse to
  do part of it and come back, and the second question usually costs almost
  nothing while the CLI is already running. The triage hint that would help on
  any other item is a defect on this one. Proposed for OW-yudoni on 2026-08-19
  and declined by the owner for exactly this reason.
- Pi fork behavior settled live on the work laptop (2026-08-20, `pi 0.84.2`):
  forking at a user message is exclusive of that message, while forking during
  a streaming turn succeeds but abandons the in-flight turn. See
  `docs/MANUAL_TESTING.md` OW-yudoni.
- A test that has never failed has not been shown to test anything. For a fix,
  break it again and watch it go red first.
- When a run overturns a fact the repo already recorded, the same change retires
  **every** copy of it. Grep the flag name or the phrase; the copies are not all
  in docs. On 2026-08-20 a run flipped `moved_file_on_disk_at_fork` and left the
  old answer standing in `docs/MANUAL_TESTING.md`, in the conclusion that
  section had drawn from it, and in the `pi/process.ts` docblock a reader meets
  at the code (034d7dd). A correction filed one section below the claim it
  corrects reaches nobody who was not already reading it.
- State the why only where there is a body behind it: an incident that happened
  or a default the reader will actually follow. Refuting something nobody would
  have tried costs the budget twice — it argues with no one, and it plants the
  bad move next to the instruction.

## Landing work

- The session agent commits directly on `main` as the work is done, small and
  single-purpose. No branch, no PR. A dispatched subagent that writes cannot —
  it is on its own worktree's branch, so it commits there and the session agent
  cherry-picks that onto `main`. Never `git push` unless asked by name.
- Where a finding goes. A doc defect: fix the doc in the same change. A fact
  you verified: the commit message, or `docs/DESIGN.md` if it changes a
  decision. Live-run evidence: `docs/MANUAL_TESTING.md`. Anything left undone
  becomes a card.
- Build-slice status lives in the Status table at the top of
  `docs/WORKSTREAMS.md` and nowhere else. That table tracks slices, not cards.

## Cards

Work items are cards. `card status` reports this repo's deck, `card workflow`
is the contract, and `card author` and `card execute` carry the two procedures.
Read those rather than a retelling; what follows is only what card cannot know
about this repo.

Card reads this deck through per-clone config that is deliberately not synced:
`.git/card/card-config.toml`, exactly three lines — `prefix = "OW"`,
`deck = "../../docs/work"` (resolved relative to `.git/card/`), and
`public = true`, which stands card's commit-lint gate down and is what keeps
citing `OW-` ids in commit subjects legal here. Writing that file, like
installing card or Bun, is the owner's provisioning of a machine, not any
session's work.

### Labels

Card treats labels as opaque strings and cannot know this repo's set. Every
card carries exactly one kind, given to `card new --label`: `change`, `defect`,
`deferral`, `question`, `unverified`. `docs/TRACKING.md`'s five-kind legend
remains the definition of what each one means. `work-laptop` is the second
label, for machine gating, and it is the only other one in use — see
"Evidence".

### Committing a card you authored

Commit it unless the user asks not to. Card never commits anything, and its
author payload is silent on git.

## Dispatching an implementer

`card worktree <id>` cuts the tree — `.worktrees/<id>`, on branch `card/<id>`,
from the branch the main checkout is on. It therefore starts at local `main`'s
tip and there is **nothing to fast-forward**: the `git merge --ff-only main`
step the old dispatch procedure carried is gone along with the staleness it
existed to fix (`docs/MANUAL_TESTING.md`, "Observed worktree base for
dispatched subagents").

`.worktrees/<id>` inside the repo tree is not a preference. On the home server
that tree is the only path mounted read-write, and a worktree anywhere outside
it fails with `Read-only file system` (`docs/HANDOFF.md`, "Environment
gotchas"); `card worktree` satisfies that by construction.

Three things card cannot know, so the dispatch prompt has to carry them:

- **`bun install` in the fresh worktree** before any `src/` work.
- A dispatched subagent does **not** inherit `CLAUDE.md` or `AGENTS.md`. Hand
  them over: tell it to read them as files in its worktree.
- **From inside a worktree the `card` CLI resolves to the main checkout's
  deck**, not the worktree's copy, so a deck-mutating verb run there writes
  outside the implementer's branch entirely. An implementer runs the read-only
  verbs only; filing and closing are the dispatching session's job.

Never `/code-review ultra` in an execution session — it has cost a full budget
window. The old skill's blanket ban on review subagents does *not* survive with
it: `card execute` positively requires dispatching an adversarial reader at
finished work, and card wins there. Only the `/code-review ultra` ban is
repo-local.

## Sessions

Ask which mode the session is in before doing anything else — including in
reply to an opening greeting. There are three. Two are the procedures
`card workflow` names in its "Onward" section: writing or sharpening cards,
which is `card author`'s, and landing one, which is `card execute`'s. The third
is the one `card status` names — "otherwise the deck needs nothing from this
session" — which is work in the repo with no card in play.

Card's own entry rule holds in the first two: when cards come up, run
`card workflow` first, then the payload for the mode you are in.
