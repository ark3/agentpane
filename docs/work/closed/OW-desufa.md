---
labels: [change, emacs]
blocked-by: [OW-bipume]
closed: done
---

# Emacs has no way to dismiss a session turn error, which since OW-bipume stays drawn until the next prompt

Found while reviewing OW-bipume, which made a session's turn error server-held and carried on every snapshot.

Before OW-bipume, an Emacs transcript buffer drew a `session/error` as a `⚠` line that the next `session/snapshot` redraw wiped, so it went away on its own at the next Codex turn boundary.
Since OW-bipume the helper puts the server's `error` on `session/snapshot` (`src/emacs/helper.ts`), and `agentpane--draw` in `emacs/agentpane.el` redraws it after the nodes until the server clears it -- which happens when a later prompt is admitted (`SessionManager.submit` in `src/server/http/session-manager.ts`) or when a client dismisses it.
The browser dismisses through the Dismiss button on its error banner: `controller.clearError` in `src/client/controller.ts` calls `api.dismissError`, the `DELETE` on `ROUTES.error(ref)` in `src/shared/protocol.ts`, served by the `"error"` case of `sessionAction` in `src/server/http/app.ts`.
The Emacs helper's JSON-RPC (`src/emacs/protocol.ts`, the handler table in `src/emacs/helper.ts`) has no verb for it, so an Emacs user cannot dismiss the error at all.

In service of `AGENTS.md`, "Both clients": dismissing a turn error is a user-facing capability the browser has and Emacs lacks.
Load-bearing: the dismissal goes to the server, not just the buffer, or the next snapshot draws the error again; and it names the error it dismisses the way the browser's does, so it cannot wipe a newer one.
Incidental: the verb's name and the key binding.

Done when an Emacs user can dismiss the drawn error in a transcript buffer and the next `session/snapshot` no longer carries it, pinned by a helper test in `src/emacs/helper.test.ts` and an ERT test in `emacs/agentpane-test.el`, each red first; the `src/emacs/protocol.ts` docblock names the new verb; and `bun run check` and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, both pass.

## Close note

Landed as 6f6210d on main.
The Emacs helper answers a new JSON-RPC verb `sessions/dismissError` `{ session, message }` -> `null`, forwarding to the same `api.dismissError` (`DELETE ROUTES.error(ref)`) the browser's Dismiss uses; `src/emacs/protocol.ts` names it in its docblock and its type map.
`agentpane-dismiss-error`, on `C-c C-d` in a transcript buffer (the prompt region included, not the composer), sends the message of the error node drawn last, which is the one the server holds, so `SessionManager.clearError` leaves a newer one standing; the buffer drops its drawn errors at once, as the browser's banner does, and a failed dismissal comes back with the next snapshot.
Verified: a new row and body assertion in `src/emacs/helper.test.ts` ("forwards each verb") went red on `unknown method "sessions/dismissError"` before the handler existed; the ERT test `agentpane-test-dismiss-error-names-it-to-the-server` went red on an unbound key, and a mutation naming the first drawn error instead of the last turned it red again.
The server half (a later snapshot carries `error: null`) was already pinned by OW-bipume's tests in `session-manager.test.ts` and `app.test.ts`.
`bun run check` (1336 tests) and the ERT suite (92 tests) pass on main.
The adversarial read found that errors drawn in Emacs are never cleared at prompt admission, as the browser's are, and on Claude Code linger through the whole next turn; that predates this card and is filed as OW-vulusi.
