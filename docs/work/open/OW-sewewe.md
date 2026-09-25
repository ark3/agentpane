---
labels: [change, d24]
---

# A session's mutating verbs run one at a time through the manager, so no set-model, set-effort, compaction, fork or reply overlaps another on one adapter

Filed 2026-09-24 under D24 in `docs/DESIGN.md`, the second of its three commitments; read that decision first.
In service of neither client's correctness resting on guards it keeps for itself.

## What happens today

The session route's `switch` in `src/server/http/app.ts` reaches the adapter directly in its `abort`, `compact`, `fork-points`, `model` and `effort` arms, through `requireAttached(ref)` or `await sessions.attach(ref)` and then `adapter.<verb>()`, and `replyToRequest` does the same for a reply.
Only the `prompt` and `fork` arms go through `SessionManager.submit` and `SessionManager.fork` in `src/server/http/session-manager.ts`, and those exist there for the re-key, not for order: each docblock says so.
Nothing orders any of them against another; OW-yavewa's close note records that nothing serialises the routes, each being a concurrent `Bun.serve` handler.
OW-woyifu is the cost: two `setModel` calls overlapping on `PiAdapter` (`src/server/adapters/pi/process.ts`) share one `settingModel` boolean and can broadcast a model at a level it was never at, and its body says a counter in place of the boolean would not be enough on its own.
OW-zayefe was the same cost one layer up: Emacs sent a set-effort without awaiting its set-model, the route-side check OW-tewofe added refused the effort against the old model, and the fix sequenced the two requests in `emacs/agentpane.el`.
The browser guards itself with `pendingModelSets`, `pendingEffortSets` and `sending` in `src/client/controller.ts` (OW-nasofa, OW-kelede); Emacs with `agentpane--sending` and `agentpane--attaching` in `emacs/agentpane.el` (OW-yoyiya, OW-yibimi), and has no guard for set-model at all, as `agentpane--check-gate`'s docstring says.
OW-derewo's close note already read a `setModel` racing a prompt as "the ordinary case of the server handling two requests in arrival order", which is the order this card makes real.

## What this card does

One queue per `ManagedSession`, a promise chain held on the container, through which `setModel`, `setEffort`, `compact`, `fork`, `reply` and `submit` run one at a time, and the route arms above call the manager for all of them.
On the container object and not in a side map keyed by ref, for the reason D12's bookkeeping constraint gives: `#adoptRef` re-keys the object, and an on-object queue follows the rename.

Load-bearing:

- No two queued verbs are in flight on one adapter at once, whichever client or clients sent them.
- A verb that rejects does not hold the next: the chain continues past a rejection.
- The queue orders admission only.
  `submit` resolves once the backend admits the turn, not when the turn ends (`BackendAdapter.submit` in `src/server/adapters/types.ts`), so nothing queued ever waits behind a running turn, and D16 stands as the adapters implement it: a mid-turn prompt steers on Pi and Codex and is rejected on Claude Code.
  Holding a prompt on the server until a turn ends was declined in OW-rifezo, and this must not reintroduce it.
- The guards the adapters own stay where they are: Claude Code's `turnActive`, Codex's `turnBusy`, `turnStartPending` and `interruptedTurnId` (OW-pefawi) and its compaction guard, Pi's `settingModel`.
  Each closes a window that ends on a backend event, which a queue of client requests cannot see.
  With one `setModel` at a time Pi's boolean is exactly sufficient, which is what OW-woyifu says a counter alone would not be.
- `close` and `disposeAll` are not queued: they are teardown, `#disposing`, `torndown` and `#terminate` are their order, and a close must not wait behind anything.
  A verb queued behind a close, or arriving after one, fails as it does today, with the adapter gone.
- It orders; it does not dedupe.
  A second identical prompt is still admitted, and the browser's `sending` and Emacs's `agentpane--sending` stay as the one-prompt-at-a-time rule.
- The adapter stays the owner of `compaction` and the manager a broadcaster (OW-jelovu); the queue adds no state of its own beyond the chain.

Incidental, for the executor to settle and record in the queue's docblock:

- Whether `abort` and `listForkPoints` join.
  `abort` must reach a running turn, which is never a queued item, so the only thing it could wait behind is a settings call, a compaction request or a fork; on Pi a fork abandons the turn anyway (D15), and OW-relehi already sends a second abort ahead of a fork and needs it harmless.
  Whatever the answer, the docblock names which verbs the queue covers and why abort is or is not among them.
- Whether the `attach` each mutating route performs first stays outside the queue, with `#attaching` as its guard, or joins it.

## Done when

- A test in `src/server/http/session-manager.test.ts`, red against today's direct dispatch: a fake adapter (`src/server/http/testing/fakes.ts`) whose `setModel` and `setEffort` resolve on demand, two calls issued through the manager without awaiting the first, asserting the adapter's second call begins only after the first has settled, in both orders, and that a rejected first call does not stop the second.
- A test in the same file overlapping `fork` with `setModel` on a Pi-shaped fake, asserting the same.
- A test in `src/server/http/app.test.ts` showing two overlapping `POST .../model` requests reach the adapter one at a time, red first.
- OW-woyifu closes under this card: its done-condition names an adapter-level test, and its incidental line allows the fix at the route or in the adapter, which this is; its close note says the adapter-level overlap is unreachable from any route and cites the tests above.
- The browser's and Emacs's guards are left in place, and the close note says why: dedupe and feedback, not order.
- `bun run check` green.
