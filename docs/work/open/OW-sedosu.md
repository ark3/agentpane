---
labels: [defect, emacs]
---

# Emacs holds one turn error, the server's, where it now draws one line per session/error

The sibling OW-vulusi's adversarial read filed on 2026-09-25, under the rule in `AGENTS.md` ("Evidence", "has found that the state has the wrong owner, not that it needs a second guard").

The browser and the server each hold one turn error per session: `view.state.sessions[handle].error` in the client state, `session.error` in `SessionManager` (`src/server/http/session-manager.ts`).
Emacs holds none: `agentpane--upsert` in `emacs/agentpane.el` appends every `session/error` as a fresh `(:error MESSAGE)` ewoc node ("always appends"), so several can be drawn at once, and every reader of the error has to guess which drawn line is the one the server holds.
Two guards already guess.
`agentpane-dismiss-error` names "the error drawn last" to `sessions/dismissError`.
`agentpane--send-prompt`, since OW-vulusi, collects the messages of every drawn error at send and, in the `sessions/prompt` reply callback, drops every drawn line whose message is among them.

The case that guard misses, confirmed by the reader with a probe test against the OW-vulusi change (c5a85fa): `session/error "A"` then `session/error "B"` arrive with no snapshot between, so Emacs draws two lines and the server holds `"B"`; the user sends; `session/error "A"` arrives again while the prompt is in flight.
The server keeps `"A"` (`session.error === priorError` is `"A" === "B"`, false), and so does the browser, but Emacs drops the new `"A"` because `"A"` was in its captured list, and shows no error.

In service of `AGENTS.md`, "Both clients": the Emacs buffer should show exactly the error the server holds.
Load-bearing: one buffer-local slot owns the session's error; a snapshot sets it from its `:error`, `session/error` replaces it rather than appending, `C-c C-d` clears it, and the send records that one string and the prompt's answer clears the slot only if it still holds that string — OW-31's rule as `submit` in `src/client/controller.ts` applies it.
The send-time message list in `agentpane--send-prompt` and the "drawn last" choice in `agentpane-dismiss-error` are the guards this retires.
Incidental: whether the slot's line is still an ewoc node or is drawn elsewhere above the prompt region, and where in the transcript it sits.

A further case the same reader named against the guard, shared with the browser and following from D2's unordered SSE and HTTP responses: a snapshot the server broadcast before `SessionManager.submit` cleared the error can reach Emacs after the prompt's reply and redraw it while the server holds null.
The reader's example was Claude Code's `beginTurn` streaming effect, which snapshotted; since OW-yirosu (ab6b1ef) that effect is a `status` event and an upsert, so the example is gone, but the case stands for any snapshot sent before the clear — the attach's on a first prompt among them.
Amended 2026-09-25 at execution: OW-yirosu also made `SessionManager.submit` broadcast a snapshot whenever it clears the held error ("No event but a snapshot says an error went"), and SSE is one ordered stream, so every stale snapshot is followed by that clearing one.
Decision: a snapshot sets the slot from its `:error`, stale or not, because the redraw it causes is transient and the next snapshot on the same stream settles it; Emacs keeps no send-time state to second-guess a snapshot, which would be a guard of the kind this card retires.
The slot's docstring records that decision.

Done when ERT tests in `emacs/agentpane-test.el` show the following, the first two red against the code before the change and the last two pinning behaviour it already had and must keep (amended at execution: the current dismissal already names the last drawn error and drops them all, and the snapshot decision above keeps today's drawing):
- the reader's case above: after two `session/error`s, a send, the first message arriving again in flight, and the answer, one `⚠` line is drawn, carrying `"A"`;
- two `session/error`s in a row leave one `⚠` line, the second;
- `C-c C-d` after two `session/error`s names the second to `sessions/dismissError` and leaves no `⚠` line (the existing `agentpane-test-dismiss-error-names-it-to-the-server` rewritten to that, if its shape no longer holds);
- a snapshot handled after the prompt's reply and still holding the cleared error draws its `⚠` line, and the clearing snapshot handled after it leaves none, as the recorded decision says;
and the existing OW-vulusi tests `agentpane-test-admitted-prompt-drops-the-drawn-error` and `agentpane-test-admitted-prompt-keeps-a-newer-error` still pass, with the full ERT suite run as the Commentary of `emacs/agentpane.el` gives it.
