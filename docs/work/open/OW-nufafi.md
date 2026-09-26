---
labels: [change, emacs]
---

# agentpane-mode's picker does not re-list on sessions/changed until some buffer has attached, because the helper opens its event stream only at sessions/attach

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's `controller.start()` in `src/client/controller.ts` connects the event stream at once, so a `sessions-changed` event or a reconnect re-lists the sidebar before anything is attached.
The helper in `src/emacs/helper.ts` opens its stream only from `sessions/attach`, and the Commentary of `emacs/agentpane.el` says so: "The notification only flows once a buffer in this Emacs has attached a session".
So a picker opened in a fresh Emacs stays as first listed until `g`.

The browser's behaviour is pinned by `src/client/controller.test.ts` "re-lists when the event stream comes back up" and the OW-dinuwu broadcast re-list tests there.
Whether the helper opens the stream at `sessions/list` or at its own start is this card's to choose.

This also fixes the picker's streaming dot for sessions no buffer attached.
A turn's start and end already broadcast `sessions/changed` (`#onUpdate` in `src/server/http/session-manager.ts`, OW-furinu), the helper forwards it, `agentpane--revert-pickers` re-lists, and the listed `isStreaming` is live, so the dot is stale today only because the stream is not open yet.

The fact that the stream opens at attach is written in three places, and the change retires every copy.
They are the Commentary sentence quoted above, the `sessions/attach` entry of `src/emacs/protocol.ts` ("Opens the event stream if it is not open yet"), and the module docblock of `src/emacs/helper.ts` ("It opens lazily at the first `sessions/attach`").
The `protocol.ts` docblock declares itself a frozen interface in the sense of D11 and asks that a change to it be raised before it is made.

Done when a test in `src/emacs/helper.test.ts` sees `sessions/changed` notified after a `sessions/list` with no `sessions/attach`, red before the change and green after.
