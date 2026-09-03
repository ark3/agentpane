---
labels: [deferral, browser-testing]
---

# The condense-side anchor assertion cannot tell a reconcile pin from a bare clamp when the scroller is already at bottom

`e2e/follow.spec.ts` -- the test "reading view keeps a streaming turn's original follow anchor locked", the condense-side assertion using `Math.min(Math.abs(anchorOffset), condensedBottom)`.

OW-gahoki established that in the bottom-pinned geometry -- where condensing leaves less than a viewport of content below the armed anchor -- `reconcile`'s cap `Math.min(bottom, anchorTop)` and Chromium's shrink clamp land on the same scrollTop.
The assertion therefore passes whether the toggle's reconcile ran or the clamp alone left the pane at bottom, and the strict `anchorOffset` branch of the `Math.min` is only exercised when enough body streamed before the toggle to make flush attainable.
The dead-toggle case is still caught today, but only indirectly: OW-gahoki's execution showed a sabotaged `toggleReading` (its `scheduleFollow` call removed) failing at 120.25px because the fixture's pre-toggle geometry is not bottom-pinned, and the settled assertion at the test's end catches a cleared anchor.

The strengthening would be a deterministic way to force the flush-attainable geometry -- stream enough body before the toggle that the anchor can reach the viewport top in the condensed layout -- so the strict branch is exercised on every run rather than by chunk-count luck.
That needs fixture-height knowledge the harness metrics in `e2e/harness.ts` do not currently expose, which is why OW-gahoki deferred it rather than doing it in place.

Done when the condense-side assertion is shown exercising its strict `anchorOffset` branch deterministically (or this is recorded as declined), with `bunx playwright test e2e/follow.spec.ts` run repeatedly in ordered-file context and `bun run test:browser` green.
