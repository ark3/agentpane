---
labels: [defect]
---

# Opening the fork picker on a Claude Code session that has not taken a turn is a 500, where Pi answers an empty list and Codex answers from the thread

`src/server/adapters/claude/adapter.ts`, `listForkPoints()`: it reads the store file through `defaultReadStoreEntries`, which throws "no Claude Code store file for session <id>" when the CLI has not written one yet.
A session created through `POST /api/sessions` and attached has a minted id and no file until the first prompt, so the fork route answers 500 for Claude only.
Pi returns `[]` from `get_fork_messages` on a fresh session and Codex reads `thread/read`.

Return an empty list when the file does not exist, and keep throwing on a file that exists and will not parse.

## Done when

A test in `claude/adapter.test.ts` calls `listForkPoints()` on a started, never-prompted adapter and asserts `[]`; it fails before the change.
