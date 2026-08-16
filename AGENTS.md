# agentpane

Decisions D1–D12 in `docs/DESIGN.md`, open work in `docs/WORKSTREAMS.md`,
closed work in `docs/CLOSED.md`, the evidence behind both in
`docs/HANDOFF.md`.

## Commands

`bun install` first. Runtime is Bun, tests are vitest. `bun run check`
(typecheck + svelte-check + all tests, ~25s) must pass before any commit
touching `src/`; say so explicitly when a commit is docs only.

`bun run test:browser` runs the Playwright vehicle in `e2e/` (~30s, headless
Chromium). It is **not** part of `bun run check` — it needs a browser, so
nothing runs it for you (OW-49). Run it by hand when you touch follow-mode
scrolling in `App.svelte` or `.conversation` in `app.css`; jsdom cannot see
layout, scroll anchoring, or real scroll-event timing.

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
- A test that has never failed has not been shown to test anything. For a fix,
  break it again and watch it go red first.

## Landing work

- The session agent commits directly on `main` as the work is done, small and
  single-purpose. No branch, no PR. A dispatched subagent cannot — it is on its
  own worktree's branch, so it commits there and the session agent cherry-picks
  that onto `main`. Never `git push` unless asked by name.
- Work items live only in `docs/WORKSTREAMS.md` and `docs/CLOSED.md`, not in
  GitHub issues or any other external tracker.
- A finding that lives only in a transcript dies with the session. A doc defect:
  fix the doc in the same change. A fact you verified: the commit message, or
  `DESIGN.md` if it changes a decision. Live-run evidence: `MANUAL_TESTING.md`.
- Anything left undone — defect, deferral, question, unproven claim — becomes an
  `OW-` row in `docs/WORKSTREAMS.md`. Cite ids elsewhere; never restate a row.
  Status lives in that file's Status table and nowhere else.

## Sessions

Work happens in one of two modes. If the user has not invoked `/author`
(writing work items) or `/execute` (landing them), ask which one before doing
anything else — including in reply to an opening greeting.

The slash-command skill definitions live in `.claude/skills/author/SKILL.md`
and `.claude/skills/execute/SKILL.md`.
