---
labels: [defect]
closed: done
---

# The Pi preview draws every message line in file order, so a session file that branched in place shows the abandoned branch as part of the transcript

Filed 2026-10-14 by the execution of OW-tadoju, from its store survey of the home server's 13 Pi files on `pi 1.2.0` (`docs/MANUAL_TESTING.md`, "The home server's Pi store, surveyed for what agentpane does not read (OW-tadoju)", the paragraph opening "One entry starts an in-file branch").

A Pi session file is a tree: each entry after the header carries `id` and `parentId`, and a branch made in place (the TUI's `/fork` or `/tree`, a retry, an edit) appends entries whose `parentId` points back past entries that stay in the file.
`extractPiPreviewTurns` in `src/server/sessions/pi.ts` maps every `type: "message"` line through `extractPreviewTurn` in file order and reads no `parentId`, so the read-only preview draws the abandoned entries as if they were on the path.
In the surveyed file, a user message was re-parented onto the system message three lines up, past a user message and an `aborted` reply, and the preview draws that pair ahead of the branch the file goes on with.
This is not rare in real use: `docs/HANDOFF.md` finding 43 counted "81 of 419 corpus files carry in-file sibling branches under one parent id" on the work laptop at `pi 0.84.2`.

The attached session is the reference the preview should match.
The `start()` comment in `src/server/adapters/pi/process.ts` says the live transcript comes from `get_messages` because it is the active branch, while `get_entries` "additionally carries pre-compaction history and abandoned branches"; `activeBranch()` in `src/server/adapters/pi/reducer.ts` already walks from `leafId` by `parentId`, for effort labels only.
A file carries no `leafId`, so which entry Pi takes as a loaded file's leaf has to be read at the source of the installed `pi` (its `pi-coding-agent` `SessionManager`, under the global Bun install, not this checkout's `node_modules`) and named with the version read; do not assume it is the last line.

In service of the preview showing the conversation the attached session would show, not a superset of it.
What is load-bearing is the path from the leaf Pi would resume at back to the root; whether the preview offers the abandoned branches some other way is not this card's question.
OW-livowu changes the same reader to draw `compaction` entries and keeps file order; whichever lands second must keep the other's behaviour.

## Done when

A test in `src/server/sessions/pi.test.ts` over a synthetic file with an in-file branch asserts that `extractPiPreviewTurns` returns only the messages on the path to the leaf, in order, and fails against today's file-order read.
A file with no branch, every entry naming the line before it, previews exactly as it does today.

## Close note

Landed in 61efa48. `extractPiPreviewTurns` now draws only the branch from the file's last non-header entry back by `parentId`, which is the leaf `pi 1.2.0`'s `SessionManager._buildIndex` takes for a loaded file (read at `dist/core/session-manager.js` under the global Bun install, recorded in the docblock); a version 1 file, whose entries carry no ids, keeps file order as `migrateV1ToV2` chains it.
The walk reuses `activeBranch` from `src/server/adapters/pi/reducer.ts`, now exported and generic; a compaction entry on the branch is still drawn as the marker (OW-livowu).
Two new tests in `src/server/sessions/pi.test.ts` failed against the file-order read and pass now; fixtures in `preview.test.ts`, `composition.test.ts` and `pi.test.ts` that were not trees Pi could write were chained as Pi appends.
The list row's one-line preview still reads the first user message in file order: OW-tegoje.
