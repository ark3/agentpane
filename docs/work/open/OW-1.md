---
kind: change
where: '`src/shared/protocol.ts` (the `snapshot` arm of `ServerEvent`), `src/client/session-state.ts:72-83`, `src/client/session-state.test.ts`'
---

# A snapshot preserves the session's `error` and its pending `requests`; the wire contract has to say so, and a test has to hold it.

The contract says a snapshot resets the sequence and is silent on both fields.
The client already preserves them -- `session-state.ts:72-83` spreads the
previous view and overrides only `ref`, `messages`, `isStreaming` and `seq` --
which was a choice nothing sanctioned either way. **Decided by the owner on
2026-08-19: preserve both.** This item writes that into the contract and pins
it.

Note the field is `requests: AgentRequest[]`, a list (`session-state.ts:16`).
This item used to say "a pending `request`", singular; the contract wording
should not repeat that.

## Why preserve, so the next reader does not reopen it

**`error` was already decided elsewhere.** OW-31 landed its lifecycle in
`1476cf6`: cleared by the Dismiss button and by the next successful `submit()`.
`clearSessionError` has exactly two callers, `controller.ts:439` and `:532`.
Adding a third at the snapshot would make an error vanish on any reconnect and
would contradict a decision that is already built and tested.

**`requests` is lossy in one direction only.** The server holds
`#pendingRequests` as `requestId -> sessionKey`
(`http/session-manager.ts:346`) -- the ownership, not the payload. It cannot
reconstruct an `AgentRequest` into a snapshot. Clearing on the client is
therefore unrecoverable, and the agent stays blocked behind an approval nobody
can see, which is the hang OW-bijera describes. Preserving a stale request you
can decline is strictly better than losing a live one.

## Why the rule is unconditional, which is the non-obvious part

It is tempting to preserve on a catch-up and clear on a wholesale change. **No
discriminator available today can express that.** The two snapshot kinds
(`broadcaster.ts:9-17`) split on *audience and counter discipline*, not on what
happened: `sendSnapshot` goes to one catching-up client and leaves the counter
alone, `broadcastSnapshot` goes to everyone so it can safely reset it to 0. And
`broadcastSnapshot` has four callers, only one of which is a content change --
`attach()` on an already-attached session (`session-manager.ts:198`, a plain
session switch), cold start (`:219`), the reducer's `reset` effect (`:403`,
the fork/compact/hydrate case), and after `renamed` (`broadcaster.ts:146`).
Both kinds arrive as `type: "snapshot"`, so the client cannot tell them apart,
and any rule keyed on the existing split would group a session switch with a
fork -- clearing a live approval every time you switch away and back.

The discriminator that *would* cut correctly is a `reason` on the snapshot
(`attach` / `resync` / `replaced`). Do not add it here. It only pays off once
it is known whether fork and compact should cancel a pending request, which is
a live-CLI question sitting with OW-bijera.

## The gap this does not close

A **fresh page load** has no previous view, so it never learns about an
already-pending request at all -- the snapshot does not carry requests, and
preserving nothing is still nothing. Fixing that means the server retaining
payloads and the snapshot carrying them, which would supersede the `requests`
half of this decision. Named so it is not mistaken for something this item
delivers.

## Done when

- The `snapshot` arm in `src/shared/protocol.ts` states that a snapshot
  replaces the transcript and the sequence and preserves `error` and
  `requests`, with the reason compressed to a clause, not this file's argument.
- A client test asserts a snapshot over an existing view leaves a set `error`
  and a non-empty `requests` intact, watched red first by making the reducer
  clear them.
- `bun run check` passes.

OW-66's fifth test depends on this being settled: it asserts a session
snapshot does not clear a session-less `notice`, which is this rule one arm
over.
