---
labels: [deferral]
---

# The client hard-codes the `virtual:` id prefix, a server construct the protocol does not carry

`src/client/controller.ts` (`detach()`), `src/server/http/session-manager.ts` (`createVirtual`), `src/shared/protocol.ts`.

Noticed while landing OW-vasubu, which needed to know inside `detach()` whether the session it had just closed had anything on disk.

The honest read turned out to be the ref's own id: `createVirtual` mints `virtual:${this.#newId()}`, and the `renamed` reducer in `src/client/session-state.ts` rewrites `state.selected` onto the new ref the moment a first prompt materialises a file, so the prefix is true exactly while there is nothing on disk.
The alternative, `summaries[].status === "virtual"`, is not: `#liveOverlay` answers `"attached"` whenever an adapter exists regardless of `session.virtual`, which `session-manager.test.ts` "keeps virtual sessions out of the backend store until prompted (D9)" asserts directly.
That reasoning is recorded in the comment at the branch and in OW-vasubu's close note, so nothing is lost if this card is never worked.

What is unsatisfying is only where the knowledge lives.
`"virtual:"` is a server-side naming convention -- `SessionRef.id` in `src/shared/protocol.ts` is an opaque string and says nothing about it -- and OW-vasubu made the client the first place outside the server to depend on its shape.
One call site is not a pattern, which is why this is a deferral and not a defect.

Done when either a shared predicate exists -- an `isVirtualRef(ref)` in `src/shared/`, with the server's own `virtual:` tests and the client's `detach()` both going through it -- or a reader decides one call site does not earn a shared helper and records that here, closing this `--declined`.
The trigger to revisit is a second client-side caller needing the same question answered.
