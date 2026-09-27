---
labels: [defect, emacs]
closed: done
---

# A client's error dismissal, and the prompt route's prior, still name the held error by text or by the server's read, not by the error the client showed

Found by the adversarial read of OW-lameke on 2026-09-26, traced by reading the code, not by a live run.

OW-lameke gave each raised turn error an identity: `ManagedSession.errorId` in `src/server/http/session-manager.ts`, taken from the manager-wide `#errorsRaised` in the `adapter.onError` subscription, and `SessionManager.submit` now clears at admission only the error whose id `errorIdOf` returned when the prompt route in `src/server/http/app.ts` read it ("Which error stood, by id, read before the attach").
The id stays on the server; neither the `error` event, the snapshot's `error`, nor any request carries it.
Two cases remain that the id would close if it crossed the wire.

1. `SessionManager.clearError(ref, message)` still compares text: `if (session?.error !== message) return;`.
   The `"error"` case in `src/server/http/app.ts` (DELETE, `DismissErrorRequest`'s `message`) passes what the client showed.
   A dismissal of "The turn ended in an error." still on its way when a newer turn error with the identical text lands clears the newer one and broadcasts `error-cleared`, so every client drops an error the backend just raised — the defect OW-lameke fixed at admission, on the neighbouring path.
   Callers: the browser's `dismissError` in `src/client/api.ts`, and Emacs's `agentpane-dismiss-error` in `emacs/agentpane.el` through the helper in `src/emacs/helper.ts`.
2. The prompt route reads the prior at the server when the POST arrives, not what the sender had seen.
   An error raised while the POST was in flight, or before the client had drawn it, is read as the prior and cleared at admission, though nobody saw it.
   This predates OW-lameke and is an inference from the code; OW-bomolu, "A start error raised inside the attach Emacs makes on its own before a first prompt is cleared at that prompt's admission, before anyone could read it", is the same shape for an attach the client made as part of sending, and lists "the prompt carrying the error its client held at send" among its incidental routes — which, since OW-lameke, means carrying the id.

In service of the server being the one owner of the turn error (OW-lohubo, OW-lameke): a clear, by dismissal or at admission, removes only the error the client that asked had shown.
Load-bearing: the identity a client dismisses or prompts against is the one the server raised and sent it, not the text.
Incidental: the identity's shape on the wire (the existing `errorId` number is the obvious one), and whether the prompt's field is optional so an older caller keeps today's server-side read.
This changes both wires — the HTTP API and the helper's JSON-RPC in `src/emacs/protocol.ts` — so it lands in both clients or in neither (`AGENTS.md`, "Both clients").
Weigh it with OW-bomolu before starting either: one wire change may settle both.

Done: a test in `src/server/http/session-manager.test.ts` beside OW-lameke's holds an error, raises a newer one with identical text, dismisses by the first's identity, and finds the newer one still held and no `error-cleared` — red first, green after; a route test in `src/server/http/app.test.ts` shows a prompt carrying no or an older identity does not clear an error raised after it; the browser's and the Emacs helper's dismiss and prompt calls send the identity they drew, each shown by a test in `src/client/` and `src/emacs/helper.test.ts`; `bun run check` passes, and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, passes if that file changes.

## Close note

Landed in one commit on main, "fix: name a turn error by its id when a client dismisses it or prompts over it, in both clients (OW-jokoto)".

The server's error id now crosses both wires: the `error` event and the snapshot carry `errorId` (null exactly when `error` is), `DismissErrorRequest` is `{ errorId }` (400 without it), and `PromptRequest.priorErrorId?: string | null` names the error the sender held when the user sent, null for none; an absent field keeps the server's own read before the attach, which only an external caller now relies on.
The Emacs helper's JSON-RPC carries the same fields on `session/error`, `session/snapshot`, `sessions/dismissError` and `sessions/prompt` (`src/emacs/protocol.ts`).
The browser sends the selected view's id at submit and `null` for a fork's first prompt; Emacs holds `agentpane--error-id` beside `agentpane--error` and reads it at the send gesture in `agentpane--send-prompt`, before `agentpane--attached-then`.

The adversarial read found that a bare per-process counter restarts at 1, so a buffer or a tab holding the old process's id could clear a restarted server's first error; the id is therefore an opaque string minted as `${#handlePrefix}:${n}`, the same per-process prefix handles carry (OW-kimaya).

Verified red first, then green: the same-text dismissal test and the restart test in `src/server/http/session-manager.test.ts`; the prompt-route tests in `src/server/http/app.test.ts` for a null and an older same-text `priorErrorId`; the controller and helper tests; and four ERT tests, among them `agentpane-test-prompt-names-no-error-its-own-attach-drew`.
`bun run check` 1457/1457, ERT 128 run with 0 unexpected, and `bun run test:browser` 26/26, the last because `e2e/harness.ts` fixtures changed.

The same change very likely settles OW-bomolu: a previewed Emacs buffer holds no error at send, so its first prompt carries `priorErrorId: null` and a start error its attach raised survives admission. The ERT test above shows the client half, and the route test with `null` the server half; neither drives a start error through `FakeAdapterFactory({ onStart })`, which is what OW-bomolu's own done condition asks for.
