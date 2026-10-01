---
labels: [change]
---

# forkAndSubmit resolves to an attach reply its only caller reads as a boolean, and its docblock still justifies the handle for a lookup nothing performs

Filed 2026-09-30 from the adversarial read of OW-pirobi, which deleted the last use of the resolved value's contents.

`send()` in `src/client/App.svelte` now reads the value `controller.forkAndSubmit` resolves to only as `if (!landed)`.
Before OW-pirobi it also read `landed.handle` to move the parent's turn marks onto the fork; that move is gone, and the fork's handle reaches the shell through the `onAttached` callback instead (OW-koledi, OW-vitefo).
The resolved summary's `ref` and `handle` are now read only by `src/client/controller.test.ts`, which asserts `?.ref` in several fork tests (for instance "expect((await controller.forkAndSubmit(0))?.ref).toEqual(forkedRef)").

Two pieces of prose still give reasons nothing uses:
- the `forkAndSubmit` docblock on `AgentpaneController` in `src/client/controller.ts`, the sentence beginning "The reply carries the fork's handle, not only its ref, because the fork's first prompt can rename it before this resolves" (OW-kimaya), which justifies a lookup by the reply that no caller performs;
- the `forkResult` docblock on `FakeController` in `src/client/App.test.ts`, which says the real controller "hands that back rather than reading `state.selected` back, so the fake must too (OW-mifuki)"; `forkResult` itself stays needed, because its handle drives `onAttached` and its truthiness drives `landed`.

The candidate change is to resolve `Promise<boolean>`, as `submit()` on the same interface does (its docblock: "Resolves **true** only when the prompt landed, the way `forkAndSubmit`..."), with the controller tests asserting the landing through state rather than through `.ref`, and both docblocks rewritten to match.
OW-sobutu (a browser fork that opens the fork with nothing sent) may add a second caller that wants the reply; whatever that card's design needs from the reply decides this one, so read it first.
If the reply has a reader once OW-sobutu is accounted for, the docblocks name that reader and the type stays.

Load-bearing: no docblock states a reason for a shape that no code relies on.
Done when either `forkAndSubmit` resolves `Promise<boolean>`, with the `controller.test.ts` fork tests adjusted and `bun run check` passing, or the type stays and both docblocks name a reader of the reply that exists in the code; in either case neither docblock justifies a lookup or a shape that nothing performs.
