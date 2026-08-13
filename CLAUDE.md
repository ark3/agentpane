# agentpane

Local web UI for coding agents; two sandboxed backends (Pi, Codex) behind one
adapter contract. Decisions D1–D12 in `docs/DESIGN.md`, open work in
`docs/WORKSTREAMS.md`, the evidence behind both in `docs/HANDOFF.md`.

## Commands

`bun install` first. Runtime is Bun, tests are vitest. `bun run check`
(typecheck + svelte-check + all tests, ~25s) must pass before any commit
touching `src/`; say so explicitly when a commit is docs only.

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

- Commit directly on `main` as the work is done, small and single-purpose. No
  branch, no PR. Never `git push` unless asked by name.
- A finding that lives only in a transcript dies with the session. A doc defect:
  fix the doc in the same change. A fact you verified: the commit message, or
  `DESIGN.md` if it changes a decision. Live-run evidence: `MANUAL_TESTING.md`.
- Anything left undone — defect, deferral, question, unproven claim — becomes an
  `OW-` row in `docs/WORKSTREAMS.md`. Cite ids elsewhere; never restate a row.
  Status lives in that file's Status table and nowhere else.

## Sessions

Invoke one at the start: `/author` writes work items, `/execute` lands them.
