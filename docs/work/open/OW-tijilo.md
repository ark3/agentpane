---
labels: [deferral]
---

# The server repeats small helpers across adapters and session readers: ZERO_USAGE, isRecord, idFromFilename, the Claude store root

Split out of OW-sozopu, which consolidated the three child-process shells and scoped itself to that plumbing.
These repeats sit beside it and were left alone there, as of 73f7123:

- `ZERO_USAGE` and `emptyUsage` in `src/server/adapters/codex/mapping.ts` and `src/server/adapters/claude/mapping.ts`, and `emptyPreviewUsage` in `src/server/sessions/preview-message.ts`.
- `isRecord` in `src/server/adapters/codex/protocol.ts`, `src/server/adapters/claude/protocol.ts` and `src/server/sessions/preview-message.ts`.
  The last one does not exclude arrays and the other two do, so merging them is a behaviour change for the preview reader, not a move; whichever definition wins, a test pins what an array input does in the preview path.
- `idFromFilename` in `src/server/sessions/codex.ts` and `src/server/sessions/claude.ts`.
- `DEFAULT_CLAUDE_ROOT = join(homedir(), ".claude", "projects")` in `src/server/adapters/claude/adapter.ts` and `src/server/sessions/index.ts`.

In service of the same thing OW-sozopu was: a fix to one copy lands in all of them.
Nothing is known to be broken; this is a deferral because no copy has yet drifted from another in a way a user saw.

Done when `rg -n 'ZERO_USAGE: Usage =|function isRecord|function idFromFilename|"\.claude", "projects"' src/server` returns one definition of each, and `bun run check` passes.
