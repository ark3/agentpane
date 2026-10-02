---
labels: [change, d27]
blocked-by: [OW-jamaha]
---

# Pi and Claude Code session names are read from the store files the walk already opens

`src/server/sessions/pi.ts` (`parsePiSession`), `src/server/sessions/claude.ts` (`parseClaudeSession` and its docblock), `src/server/sessions/line-reader.ts`, `src/shared/protocol.ts` (`SessionSummary.name`)

Two of three backends put a user-given session name into the file `src/server/sessions/` already reads, so the list can show those names with no new process.
The third, Codex, keeps its name outside the rollout, and a separate card carries a collector for it; this card is Pi and Claude only, and does not wait for that one.
The field this fills, `SessionSummary.name`, is added by the card this one is blocked on.

## Where the names are, measured 2026-09-15

`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire", is the record.

- Pi (`pi 0.85.1`): a `{"type": "session_info", "name": ...}` entry, appended once per rename after the messages that preceded it, so a rename made late sits late in the file.
  The latest entry wins, and an empty name clears; that is what `pi`'s own reader does, `getSessionName` in `dist/core/session-manager.js` of the installed package.
- Claude Code (`claude 2.1.270`): a `{"type": "custom-title", "customTitle": ...}` line, appended once per rename and re-emitted afterwards, so the same title can appear several times and the last one is current.
  The store also carries `ai-title` lines, model-generated; those are not the user's name and stay out of this card.

## The read that has to change

Both parsers stop at the first user message with text: `parsePiSession` breaks once `preview` is set, and `parseClaudeSession` breaks once id, cwd, timestamp and preview are all in hand.
A name set after the first prompt, which is the only kind the owner is interested in, lies past that break.
Reading on to the end of every file on every listing is what D9 declined, and `line-reader.ts` bounds reads for that reason, so the reader has to find the name without giving that up.
Reading the tail of the file is the obvious shape: both entries are appended, the last one is current, and neither backend rewrites the file on rename.
What is load-bearing is that enumeration stays cheap on the real corpus; how the tail is read is the implementer's call, and the docblock of `src/server/sessions/claude.ts` already names a tail read as the mechanism a title-led preview would want.

That docblock's paragraph beginning "Preview: first human message" declined `ai-title` for the preview and called itself a first cut; it does not speak to `custom-title`, and this card is the revisit it asked for.
Update it in the same change so it describes what the parser now does with both line types.

The preview stays the first human message.
How a row shows a name is `docs/DESIGN.md` D27's label rule, which OW-bumonu draws in the browser and OW-jidihu in agentpane-mode; this card is server-only, amended 2026-10-01 under D27 to drop the client test it carried.

## The attached overlay

As OW-jamaha left it on 2026-10-01, an attached session's summary takes `name` from its adapter, unconditionally, in `#liveOverlay` in `src/server/http/session-manager.ts`.
Claude Code's adapter reports `null` for a title it did not set itself, so once this card reads `custom-title`, an attached Claude session would list no name where the same session detached lists its title.
Whether the overlay keeps the walk's name when the adapter reports `null` is this card's decision; OW-jamaha dropped a fallback that pre-empted it, because nothing could trigger it before this card.

## Done when

Each watched red first.

1. A Pi parser test builds a file whose `session_info` entries come after several messages, with a later one clearing the name, and asserts the summary's `name` follows the last entry.
2. A Claude parser test builds a file with a `custom-title` line after the first assistant message, repeated later, and asserts `name` is that title and `preview` is still the first prompt.
3. A test in `src/server/http/` attaches a Claude session whose stored summary carries a name, with the adapter reporting `null`, and asserts the listing shows whatever "The attached overlay" decided.

`bun run check` passes, and a listing of the home server's real corpus is timed before and after, the figures recorded in the close note with the date; that timing is the guard on enumeration staying cheap, since no parser-level bounded-read test exists (`src/server/sessions/line-reader.test.ts` bounds the reader alone), and OW-20, which waits on a measured listing latency, gets one from it.
