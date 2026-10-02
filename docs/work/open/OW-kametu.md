---
labels: [unverified, d27]
---

# Renaming a Claude Code or Codex session before its first turn or during a turn is measured, and the name route follows what it shows

`src/server/http/app.ts` (the `case "name"` route), `src/server/http/session-manager.ts` (`setName`), `src/server/adapters/claude/adapter.ts` and `src/server/adapters/codex/adapter.ts` (`setName`), `docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire"

OW-jamaha landed the rename wire on 2026-10-01, and its route accepts a name for any attached session: one created here and not yet prompted, and one mid-turn.
The evidence it rests on never tried either: every probe in the MANUAL_TESTING section above ran a turn first, and for Claude it says "Nothing here was tried before the first turn or during one."
This card is in service of D9's promise that opening a session never litters the store with an empty one, and of the adapters' existing refusals while a turn runs (OW-jihete for Claude's `submit`).

Pi is settled for the first half at the source: as of `pi 1.0.0`, `_persist` in `agent-session.js` returns until `_hasConversation()`, so a name set before the first prompt is held in memory, not written.
Claude Code (`claude --model haiku`) and Codex (`codex -m gpt-5.6-luna`) are not: a `rename_session` control request or a `thread/name/set` before the first turn may fail, or may write a store file for a session with no conversation.
During a turn, each may accept the rename, refuse it, or queue it behind the turn the way a stream-json user message queues behind the first `result` (OW-jihete).

The browser cannot stand in for the route here.
Its Rename item (OW-bumonu, `renamable` in `src/client/App.svelte`) is disabled mid-turn but offered before the first turn, as Emacs's `M-x agentpane-rename-session` (OW-jidihu) is refused and allowed, and it asks for the name with `window.prompt`, which blocks the page: a turn started from Emacs while that dialog is open is processed only after the POST has gone out, so a mid-turn rename reaches the route whatever the client gates.

Load-bearing: whether a pre-turn rename creates a store file, and whether a mid-turn rename is answered before the turn ends.
Incidental: the exact error text of a refusal.

## Done when

1. A live run on the home server, with both CLIs pinned to their models, records in `docs/MANUAL_TESTING.md`, under a section naming this card and each CLI's version, what a rename before the first turn and one mid-turn did: the response, its timing against the turn, and whether a store file appeared.
2. Where a run shows a rename writes an empty session or misbehaves mid-turn, the route or the adapter refuses that case, with a route or adapter test watched red first, and `renamable` in `src/client/App.svelte` withholds the item in the same case, with an `App.test.ts` case watched red first, as `agentpane--check-renamable` in `emacs/agentpane.el` refuses `M-x agentpane-rename-session` (OW-jidihu), with a case in `emacs/agentpane-test.el`'s `agentpane-test-rename-session-refused-where-the-browser-offers-no-rename` watched red first; where it shows neither, the close note says so and nothing changes.
