---
labels: [change, emacs]
blocked-by: [OW-wavone]
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
