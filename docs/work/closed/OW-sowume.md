---
labels: [change, emacs]
closed: done
---

# agentpane-mode's picker shows an empty Preview for a just-prompted session whose stored preview is still null, where the browser labels it by its first user message

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`sessionLabel` in `src/client/App.svelte` labels a row by the server's stored preview and, while that is still null, by the first user message in the session's live view, then by backend and id.
`agentpane--session-entry` in `emacs/agentpane.el` takes the Preview column from the summary alone, so a session just prompted from Emacs shows an empty Preview until its store catches up.

The window is roughly the first turn.
A turn's end broadcasts `sessions/changed` (`#onUpdate` in `src/server/http/session-manager.ts`, OW-furinu), and the re-list it causes brings the stored preview in, once the helper's stream is open.

No wire is needed: the transcript buffer of that session already holds its nodes.

The `sessionLabel` docblock in `src/client/App.svelte` says "only create/attach/rename/close emit `sessions-changed`" and that the label "stays null until the next reload", which OW-furinu's turn-boundary broadcast made false.
That docblock is corrected in the same change.
The browser's behaviour is pinned by `src/client/App.test.ts` "labels a just-prompted session by its own first user message while the server preview is still null".

Done when an ERT test in `emacs/agentpane-test.el` lists a session whose summary preview is null while its transcript buffer holds a user node, and finds that node's text in the row, red before the change and green after.

Amended 2026-09-27 at execution, after the adversarial read: reading the transcript only when a listing arrives misses the window, because the user node reaches Emacs after both of the first prompt's listings on Codex (its `userMessage` item comes 1.1–2.5s after the turn starts, in `resources/fixtures/codex/`) and can race the list reply on Pi.
The browser's label is reactive; the Emacs picker's rows must be re-rendered when a transcript buffer first draws a user node for a session a picker lists with a null preview.
So done also needs an ERT test that lists such a session while its buffer is empty, delivers a user node through the draw path, and finds the text in the row with no new listing, red first.
A multi-line first prompt must stay on one row, whitespace collapsed as `trimPreview` in `src/server/sessions/text.ts` does, also shown red first.

## Close note

Landed on main as e073a25, d07e357 and bbc9ab8.
agentpane-mode's picker now fills an empty Preview from the first user node with text in the transcript buffer holding the session (`agentpane--first-user-text` in `emacs/agentpane.el`, found by handle then ref, never creating a buffer), with whitespace runs collapsed to one space as `trimPreview` does, so a multi-line prompt stays on one row.
The adversarial read found that reading it only at a listing misses the window: the first prompt's listings answer (~0.25s) before the user node reaches Emacs on Codex (userMessage 1.1–2.5s after turn/started in `resources/fixtures/codex/`, codex-cli 0.147.0 and 0.153.4), and can race the draw on Pi.
So the draw path now owns it too: `agentpane--upsert` (a user node at a new index) and `agentpane--draw` (a snapshot) call `agentpane--preview-pickers`, which re-renders each picker listing the session with a null preview and an empty Preview cell through `agentpane--redraw-rows`, extracted from `agentpane--clear-seen-turns`.
The listing-time read stays, for a picker opened after the node was drawn.
The `sessionLabel` docblock in `src/client/App.svelte` no longer claims nothing re-lists a session after its first prompt; it names OW-furinu's turn-boundary broadcast.
Verified: ERT tests `agentpane-test-picker-previews-a-just-prompted-session-by-its-transcript` (listing-time, multi-line) and `agentpane-test-picker-previews-a-user-node-drawn-after-its-listing` (node delivered through `session/node` and the draw timer, row filled with no re-list, exactly one redraw) both red against the pre-fix code and green after; full ERT suite 153 tests, 0 unexpected, 3 skipped as before; `bun run check` green on main.
Left as is: the picker locates the Preview cell as a row's last column, and a blank-only user node or snapshot reprints a matching picker each time since the cell stays empty.
