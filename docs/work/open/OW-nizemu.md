---
labels: [defect]
---

# An attach a preview supersedes leaves busy on "attaching" until some other action resets it, so Ctrl-G and the External Editor silently refuse

Found 2026-10-15 by the adversarial read of OW-momejo, and confirmed against the source; it predates that card.

`attachAndSelect` in `src/client/controller.ts` publishes `busy: "attaching"` and returns it to `"idle"` in its `finally` only when `intent === selectionIntent`, as does the `create` path beside it.
`preview` bumps `selectionIntent` and never writes `busy`, and neither does its reselect of a session already live here.
So an attach that a preview supersedes leaves `busy` on `"attaching"` for good.
The sequence the reader gave: click Attach on a stored session, then before the attach replies click any sidebar row (`controller.preview`) or change the workspace filter, which fires the auto-preview.
The attach lands in `attachAndSelect`'s `else` branch, its `finally` skips the reset, and the status line reads "Opening session…" while Ctrl-G and the External Editor, both gated on `busy === "idle"`, silently do nothing.
It heals only at the next submit, abort, compaction, or an attach still current when it ends.
The reader reproduced it in a controller-level scratch test (`editDraft` made no call), and OW-momejo's App tests hit it through `streamingPi` in `src/client/App.test.ts`, where the mount's auto-preview supersedes the harness's own `controller.select`; the `settledSelection` helper OW-momejo added there selects a second time to get past it, and every other `streamingPi` test runs with `busy` stuck unremarked.

The same mechanism was fixed once for forks: see the comment at `takesSelection` in `forkAndSubmit` (D17, OW-miyemo).
That was a fix at one site; the state to fix is that `"attaching"` has only one writer who may clear it, and a superseding selection is not that writer.
Whoever owns the selection intent should own the busy it implies, so that a preview or reselect ending an attach's claim ends its `busy` too, rather than a further check at each site that supersedes.

## Done when

- A test in `src/client/controller.test.ts`, red first: `select` a stored session with the attach held open, `preview` another before it replies, let the attach reply, and assert `busy` is `"idle"` and `editDraft` reaches `api.editDraft`.
- `settledSelection` in `src/client/App.test.ts` is gone, and OW-momejo's tests that used it pass without it.
- `bun run check` passes.
