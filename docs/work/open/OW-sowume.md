---
labels: [change, emacs]
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
