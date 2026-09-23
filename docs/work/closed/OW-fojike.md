---
labels: [change, emacs, emacs-native]
blocked-by: [OW-wavone]
closed: done
---

# agentpane-mode forks at the user message at point into a second transcript buffer, leaving the original attached and usable

Filed 2026-09-15, the native-mode stream (OW-mutufa, OW-refibu, OW-wavone).
The counterpart of OW-limejo, and the feature that makes the second transcript buffer worth having.
Where OW-limejo carries the fork point through ACP's `_meta` and a copied config because ACP's fork has no fork-point parameter, here the point is a request argument and the elisp is one command.

## The command

`agentpane-fork` in the transcript buffer reads the `index` of the ewoc node at point, sends `sessions/forkPoints` and matches a point by `index` (D20); a message no point names is not forkable and the command says so, which is the same rule the browser applies by offering no Edit control there.
It then sends `sessions/fork` with the point's id, opens a transcript buffer for the returned ref, and attaches it.
The original buffer stays as it was: OW-razoki landed the parent surviving a Claude fork (closed 2026-09-13), so both parents are left attached and usable on Claude and Codex alike, and Pi's abort-before-fork is the server's (D15), not the mode's.
`agentpane-fork` with a prefix argument forks at the last point, which is the tip-fork `agent-shell-fork` offers.

Fork points are fetched on demand and never cached in the buffer, since a Codex steer changes the point set (OW-roveze).

## Blocked on this card's own stream only

OW-limejo waits on OW-basoga for its shim; this card waits on OW-wavone for the buffer and its `index` at point.
It does not need the live slice: forking a previewed, detached session is allowed and the result attaches, which is the browser's behaviour too.

## Done when

An `ert` test with a stub connection asserts that `agentpane-fork` at a node whose index a fork point names sends `sessions/fork` with that point's id, and at a node no point names sends nothing and reports it.
On the home server against Codex: fork at an earlier user message, see the new buffer hold only the history up to it, then send a prompt in each buffer and see both answer; record it in `docs/MANUAL_TESTING.md` with versions.

## Amended 2026-09-22 at execution

The prefix-argument variant is dropped.
It read "forks at the last point, which is the tip-fork `agent-shell-fork` offers", but a fork point is exclusive of the user message it names on every backend: Codex's `fork` in `src/server/adapters/codex/adapter.ts` keeps "everything through the turn before it", Claude's `listForkPoints` names the entry before the user message (or `CLAUDE_FORK_SESSION_START`), and Pi's fork at a user message is exclusive (`AGENTS.md`, "Pi fork behaviour").
So forking at the last point discards the last exchange, which is not a tip-fork, and agentpane has no request that forks at the tip.

"Hold only the history up to it" in the live condition therefore means the history before that user message, without the message itself.

Forking a detached session needs nothing from the mode: the server's `fork-points` and `fork` routes in `src/server/http/app.ts` attach the parent themselves.

A Pi fork moves the parent's live container onto the fork and leaves the parent detached (`SessionManager.fork` in `src/server/http/session-manager.ts`, and the `fork` route's comment in `app.ts`), without a `renamed`.
The original buffer must still be usable after a Pi fork, which the mode's idea of whether that buffer is attached has to survive.

"Pi's abort-before-fork is the server's (D15), not the mode's" was wrong: D15's abort is the client's, `forkAndSubmit` in `src/client/controller.ts` sending `api.abort` when the ref is Pi and the session is streaming, and the server's `fork` route aborts nothing.
So `agentpane-fork` does the same on a streaming Pi buffer before it forks.

## Close note

Built: `agentpane-fork`, on `f` in `agentpane-transcript-mode`, in `emacs/agentpane.el`.
It reads the index of the node at point, fetches `sessions/forkPoints` fresh each time and matches by `index` (D20); a message no point names forks nothing and says so.
Otherwise it sends `sessions/fork` with the point's id and opens the fork in a transcript buffer of its own, attached, shown in the window that showed the parent.
One fork at a time per buffer.
On Pi it aborts a streaming turn first, as the browser's `forkAndSubmit` does under D15 (the card had placed that abort in the server, which was wrong), marks the parent buffer detached, and redraws it from the store, working around OW-zovaye.
The card's prefix-argument "tip-fork" was dropped at execution: a fork point excludes the user message it names on every backend, so forking at the last point discards the last exchange, and agentpane has no tip-fork.

Verified: ert, `Ran 23 tests, 23 results as expected, 0 unexpected` on Emacs 31.1, each new test shown red first, and the adversarial reader's two mutants (every parent detached; fork sent alongside the abort) now caught.
Live on the home server against Codex (`codex-cli 0.156.0`, `gpt-5.6-luna` chosen in the picker), recorded in `docs/MANUAL_TESTING.md`, "The native Emacs mode forks a Codex session live (OW-fojike)": `f` on an assistant node forked nothing; `f` on the second user message opened a buffer holding only the first exchange, the original kept its four nodes and stayed attached, the fork ran on the parent's app-server, and a prompt in each buffer answered there without touching the other.
Pi was not run live.

Filed from the work: OW-buligi (a Codex fork's stored transcript lacks its inherited history), OW-zovaye (a Pi fork's rewound snapshot is broadcast under the parent's ref), OW-gekiki (`f` in a previewed buffer can match a different message).
