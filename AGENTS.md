# agentpane

Decisions D1–D14 in `docs/DESIGN.md`, the evidence behind the work in
`docs/HANDOFF.md`. Work items are one file each under `docs/work/open/` and
`docs/work/closed/` — **status is the directory**. `docs/TRACKING.md` specifies
the file format and why it is shaped that way.

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
- **Neither backend CLI runs on the home server.** It has no `pi` at all, and
  while Codex is installed there, running it is expensive enough that it is not
  to be run without being asked. Both run on the work laptop, which is why an
  item whose evidence has to come from a live turn belongs there and carries
  the marker `docs/TRACKING.md` names. Collect them with
  `rg -l '^\*\*Work laptop:\*\*' docs/work/open | sort -V`. Reading a
  captured fixture under `resources/fixtures/` is not a live run and is fine on
  either. Name the machine rather than writing "here": this file is checked in
  and read from both clones, so a sentence that resolves against the reader's
  location is false on one of them.
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
- Work items live only in `docs/work/`, not in GitHub issues or any other
  external tracker. One file per item; a bare id resolves against **both**
  directories, `docs/work/{open,closed}/<id>.md`, because an item cited
  somewhere may have closed since — on 2026-08-20 an agent given a bare id
  looked only in `open/` and reported the item missing. Closing an item is
  a `git mv` into `docs/work/closed/` plus a `**Fixed** in <sha>: <evidence>`
  paragraph appended to the body. A closed item is kept rather than deleted,
  because its close note is sometimes the grounding a later one needs — what
  was agreed, what was tried, what the evidence was.
- A finding that lives only in a transcript dies with the session. A doc defect:
  fix the doc in the same change. A fact you verified: the commit message, or
  `docs/DESIGN.md` if it changes a decision. Live-run evidence:
  `docs/MANUAL_TESTING.md`.
- Anything left undone — defect, deferral, question, unproven claim — becomes
  an open work item: a new file in `docs/work/open/`, its id **drawn, not
  chosen** (`.claude/skills/author/SKILL.md`, and `docs/TRACKING.md` for why).
  Cite ids elsewhere; never restate an item.
- Build-slice status lives in the Status table at the top of
  `docs/WORKSTREAMS.md` and nowhere else. That table tracks slices, not work
  items; an item's own status is which directory its file sits in.

## Sessions

Work happens in one of two modes. If the user has not invoked `/author`
(writing work items) or `/execute` (landing them), ask which one before doing
anything else — including in reply to an opening greeting.

The slash-command skill definitions live in `.claude/skills/author/SKILL.md`
and `.claude/skills/execute/SKILL.md`.
