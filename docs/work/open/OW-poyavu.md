---
labels: [deferral]
---

# Why the client never calls the DELETE route is recorded only in controller.ts, a module away from the code that would falsify it

Raised reviewing the close for OW-puduro, 2026-09-10, and left undone there because the owner's go-ahead covered only the card closes and the comment trim.

OW-puduro landed a comment in `src/client/controller.ts`, above the first `if (disposed) return null;` after `const forked = await api.fork(...)`, that declines fork cleanup.
Its reasoning is a chain of server internals, none of which live in that file:

- `SessionManager.fork`'s `finally` calls `#adoptRef`, which re-keys the table and aliases the parent's id onto the fork, so on Pi and Claude Code the parent ref and the forked ref resolve to one live adapter.
- `close()` reaches `session.adapter?.dispose()` and never touches the session file.
- `close()` also deletes every alias whose target is the key it is closing.
- `list()` skips any ref that is an alias key, which is what hides the parent file today.
- Codex's `adapter.fork()` leaves `currentRef` alone, so `#adoptRef` no-ops and the forked thread is in no table until the attach.

All five are in `src/server/http/session-manager.ts`.
Someone changing `close()`, the aliasing, or the `DELETE` route has no reason to open the client controller, so the comment can go quietly false.
AGENTS.md's own rule is that when a run overturns a recorded fact the same change retires every copy, and that rule only works if a reader can find the copies from where they are standing.

The other half is that OW-35 carries a standing constraint to keep the `DELETE` route, and a reader meeting that constraint has the obvious question -- who calls it? -- with the answer, nobody, and deliberately, sitting a module away.

## Done when

The server side of this says it: a short note at `SessionManager.close` or at the `DELETE` route in `src/server/http/app.ts` recording that no client calls it, that OW-puduro decided the client never will, and that disposing the adapter would kill the live process a forked ref resolves to.
It cites OW-puduro rather than restating the chain, so there is one copy of the reasoning and one pointer to it, not two copies to drift apart.

Whether OW-35's constraint to keep the route still earns its keep with no caller is a live question this does not settle and should not be folded into it; if the answer looks like no, that is its own card.
