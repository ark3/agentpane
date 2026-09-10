---
labels: [defect, now]
closed: done
---

# Opening the fork picker on a Claude Code session that has not taken a turn is a 500, where Pi answers an empty list and Codex answers from the thread

`src/server/adapters/claude/adapter.ts`, `listForkPoints()`: it reads the store file through `defaultReadStoreEntries`, which throws "no Claude Code store file for session <id>" when the CLI has not written one yet.
A session created through `POST /api/sessions` and attached has a minted id and no file until the first prompt, so the fork route answers 500 for Claude only.
Pi returns `[]` from `get_fork_messages` on a fresh session and Codex reads `thread/read`.

Return an empty list when lookup finds no file, without changing the existing read and parser behavior once lookup finds one.

## Done when

A test in `claude/adapter.test.ts` calls `listForkPoints()` on a started, never-prompted adapter and asserts `[]`; it fails before the change.

## Close note

Claude fork-point enumeration now returns an empty list when a started, never-prompted session has no store file yet.
A regression test exercises the default reader against an isolated empty Claude root; it failed before the production change with `no Claude Code store file for session never-prompted` and passed afterward.
`bun run check` passed on the landed main commit with 48 files and 963 tests.
During review, the card's claim that an existing malformed JSONL file throws was corrected: the shared Claude parser deliberately tolerates malformed and unknown lines, so the change preserves the established read/parser behavior for files lookup does find.
