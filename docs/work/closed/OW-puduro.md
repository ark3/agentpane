---
labels: [defect, now]
closed: declined
---

# A fork whose attach or prompt never lands stays on the backend, and no client verb can clean it up

Noticed by the implementer on OW-mifuki, 2026-09-09, and recorded in that card's close note as "noticed and not filed separately" rather than as a card.
Read off `src/client/controller.ts`; not reproduced against a running backend.

`forkAndSubmit` in `src/client/controller.ts` mints a conversation at `const forked = await api.fork(ref, { entryId: point.id })` and the original survives, per `fork`'s docblock in `src/client/api.ts`.
Everything that follows can abandon it.

## The trigger OW-mifuki named is gone; the leak is not

That close note attributes this to "the new intent guard" tripping after `api.fork` succeeded.
That door closed the next day.
D17 (OW-miyemo) made the guards non-selecting continues rather than returns, because bumping past the user's own in-flight click stranded it -- see the comment ending "`busy` stuck on \"attaching\" forever (D17, OW-miyemo)".
`takesSelection` now decides only whether the intent bumps and whether `applyAttached` moves the user, and the attach and the prompt both still run.
So a card written against the note's wording would send its agent looking for a return that is not there.

Two doors are live in the current code, both after the fork has succeeded:

- `if (disposed) return null;` immediately after the `api.fork` call, and again after `api.attach`.
- The `catch` at the end of `forkAndSubmit`, which publishes the message and returns `null`, reached by any throw from `api.attach` or `api.prompt`.

Neither is new in shape: OW-mifuki's note observes that a rejected `api.attach` already did this.
What changed is the traffic through them, since a plain click now reaches the path.

## Nothing in the client can undo a fork

`AgentpaneApi` in `src/client/api.ts` has no delete, close or discard verb -- read the interface, it ends at `fork` and `connect`.
The server's `DELETE` route exists and OW-35 carries a standing constraint to keep it, but no client code calls it, which OW-35 also records.
So the cheap repair is not available: any cleanup fix adds a verb to that interface first, and that is the part worth deciding before any code is written.

Weigh it against simply accepting the orphan.
A forked session that nothing attached is a file on disk and, on Codex, a minted thread nothing is driving -- it costs storage and list clutter, not a running subprocess, and the `disposed` door only fires when the whole controller is going away.
OW-gajesu is adjacent and still open: whether a fork Pi has not yet been prompted from exists on disk at all is unsettled, and its answer bounds how much of this is even observable on that backend.
It is `work-laptop` and this card is not; do not block on it, but read it before concluding the orphan is always real.

## Done when

Whichever way the decision goes, it is recorded where the next reader meets the abandonment -- at the `catch` and the `disposed` returns in `forkAndSubmit`, not only here.

If cleanup is taken up: a test in `src/client/controller.test.ts` drives a `forkAndSubmit` whose `api.attach` rejects after `api.fork` resolved, and asserts the fork is disposed of; it fails before the change.
If it is declined: this card closes `--declined` with the reason, and the comment at those returns says the orphan is deliberate, so the next reader stops re-deriving the leak.

## Close note

Declined: the orphaned fork stays, and the reason is now recorded at the three sites that abandon it (3f9437c, `src/client/controller.ts`).

The card asked which way to go and named the decision as the part worth settling before any code. The code settles it against cleanup, for a reason the card did not have: the server's `DELETE` route disposes the **adapter**, never the file (`SessionManager.close`), so the cleanup verb the card was weighing could not have removed the orphan from the picker on any backend.

Worse than useless on two of three backends:

- **Pi and Claude Code.** The fork moves or respawns the live process onto itself and `SessionManager.fork`'s `finally` re-keys the table, so the forked ref and the parent ref both resolve to the one live adapter through `#aliases`. `close(forkedRef)` reaches `adapter.dispose()` on it -- the call kills the agent the user is talking to. It also deletes every alias targeting that key, which un-hides the parent file `list()` had been suppressing: a cleanup that leaves the picker with more entries than it started with.
- **Codex.** `adapter.fork()` never touches `currentRef`, so `#adoptRef` no-ops and the forked thread is in no table until the attach. `close()` returns early and the route still answers 204. Only past a successful attach would the call reap anything, and what it reaps is one idle `codex app-server` child. One backend, one exit: not worth a verb on `AgentpaneApi`.

The card's own hedge held up. What abandonment actually costs is a session file at most, and whether one exists before the first prompt is settled only for Codex -- OW-gajesu is open on Pi, and nothing had ever read Claude's, which is now **OW-fejota**, filed from this execution.

Two corrections to the card's framing, from an adversarial read of the comment before it landed. The card names three abandonment points; there is a fourth, the `disposed` return after `api.prompt`, where a turn is running -- the comment scopes itself "up to the prompt" for that reason. And the `disposed` returns are close to dead in production: `dispose()` is called only from `App.svelte`'s `onMount` cleanup, which a real tab close does not run. The `catch` is the reachable path.

No test was written: the declined branch has no behaviour to pin, and the fake api in `src/client/controller.test.ts` could only have proved the client sent a request, never that it accomplished anything -- the facts above are not reachable from a controller test.
