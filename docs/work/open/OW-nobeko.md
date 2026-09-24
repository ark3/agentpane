---
labels: [deferral]
blocked-by: [OW-bijera]
---

# Three Codex request tests went vacuous when OW-zisumi declined every request at arrival, and need their subject back once requests are held again

Filed 2026-09-24 while closing OW-zisumi.

OW-zisumi made the Codex adapter decline every request with a `DECLINE_RESPONSES` entry the instant it publishes it: the `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts` calls `this.reply(key, null)` and fires `resolvedListeners` right after the request listeners.
So no published request is ever still pending when the next line is read, and three pieces of the adapter lost every test that could fail for them.
They are not dead code: OW-bijera, once a human can answer, is expected to hold requests again (D2a in `docs/DESIGN.md`, the paragraph "This is provisional"), and then all three are live paths with nothing guarding them.

- `wireRequestKey` keeping a numeric `0` and a string `"0"` apart.
  The test "distinguishes numeric and string wire request ids" in `src/server/adapters/codex/adapter.test.ts` now only shows each decline goes out under its own typed id; the first request's mapping is gone before the second arrives, so a `wireRequestKey` that collapsed the two would still pass.
- `clearPendingRequests` on a failed start.
  The test "drops requests received before a failed start before a later retry" in the same file passes for any code, because the request is declined on the failed process before the cleanup could matter.
- The `"request-resolved"` case of `applyEffects`, where Codex's `serverRequest/resolved` names a request `reply` has not answered.
  The two OW-gusifo tests, now named "reports a request it declined resolved once, under the id it was published with, and not again when Codex resolves it (OW-gusifo)" and "reports a child-thread request routed through the parent resolved once, and not again when Codex's notification names the child (OW-gusifo)", show only the negative half; the positive path — retract a still-held request Codex resolved on its own, including a child-thread one routed to the parent (OW-futewo) — is reachable by no published request.
  D2a's OW-gusifo paragraph says so in the line beginning "Until OW-bijera the first finds nothing to act on".

This is in service of OW-bijera landing without a silent coverage hole, and is blocked by it because until requests are held there is no behaviour for these tests to observe.
If OW-bijera instead keeps declining some kinds, the tests go on a kind it holds; if it holds none, this card is moot.

## Done when

- For each of the three, a test in `src/server/adapters/codex/adapter.test.ts` that drives a held request goes red when the logic it names is broken by hand (collapse `wireRequestKey` to `String(id)`, drop the `clearPendingRequests()` call on the failed start, drop the `resolvedListeners` call in the `"request-resolved"` case) and green once restored.
- D2a's line "Until OW-bijera the first finds nothing to act on" is gone or true.
