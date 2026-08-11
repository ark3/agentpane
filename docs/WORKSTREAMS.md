# Workstreams

Five workstreams are built **in parallel**, each in its own git worktree. This
document is the coordination contract. Read `HANDOFF.md` and `DESIGN.md` first
— they carry the decisions and the evidence; this only says who builds what.

## The rule that makes parallelism safe

**Own your directory. Do not edit anyone else's.** Merge conflicts between
parallel agents are the main failure mode, and disjoint file ownership is the
only reliable defence.

| Workstream | Owns | Verify against |
|---|---|---|
| **pi-adapter** | `src/server/adapters/pi/` | `resources/fixtures/pi/*.jsonl` |
| **codex-adapter** | `src/server/adapters/codex/` | `resources/fixtures/codex/*.jsonl` |
| **session-index** | `src/server/sessions/` | the real `~/.pi/agent/sessions` and `~/.codex/sessions` |
| **transport** | `src/server/http/`, `src/server/index.ts` | the wire contract, with a fake adapter |
| **renderer** | `src/client/render/` | hand-built `AgentMessage[]` samples |

Everything else — `src/shared/`, `src/server/adapters/types.ts`,
`package.json`, `tsconfig.json`, `vite.config.ts` — is **frozen**. If you need
a change there, stop and raise it; do not edit it and hope.

`src/client/App.svelte` and `src/client/main.ts` are placeholders belonging to
a later client-shell workstream. Leave them alone.

## Frozen interfaces

- `src/shared/protocol.ts` — the wire contract (D11). SSE event union, REST
  request/response types, `ROUTES`, `SessionRef`, `SessionSummary`.
- `src/server/adapters/types.ts` — `BackendAdapter`, which both adapters
  implement identically.

These were written to be built against by people who cannot talk to each
other. If something in them is ambiguous, that is a defect worth reporting.

## Conventions

- **Runtime is Bun**; tests are vitest. `bun install` first — a fresh worktree
  has no `node_modules`.
- **`bun run check` must pass** before you are done (typecheck + svelte-check +
  all tests). Not just your own tests.
- **Two test projects.** Server-side tests (`src/server/**`, `src/shared/**`)
  run in `node`; client tests (`src/client/**`) run in `jsdom`. You do not need
  per-file environment docblocks — just put the file in the right place.
- **Path aliases**: `$shared/*`, `$server/*`, `$client/*`. Imports carry real
  `.ts` extensions.
- **The pi packages are types-only** (D10). `import type` only —
  `src/import-boundaries.test.ts` fails the build otherwise, naming your file.
- Assert on **structure**, never on model wording — fixture text varies per
  capture.

## What "done" looks like

Your directory implements its slice, with tests that run offline and with no
live model calls. `bun run check` is green. You have committed on your
worktree branch.

**Report anything the docs got wrong or left ambiguous.** Guessing silently is
the one outcome that makes parallel work worse than serial. A gap you flag gets
fixed once, centrally; a gap you paper over surfaces at integration, five times
over, in five different shapes.

## Integration

Merging and reconciling is deliberate serial work, done after the parallel
phase. Do not attempt to integrate with another workstream's code — if you need
something that does not exist yet, define the seam against the frozen
interfaces and note the assumption in your report.
