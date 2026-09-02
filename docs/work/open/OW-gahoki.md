---
labels: [defect, browser-testing]
---

# Reading-view condensing races an older follow frame, so the browser anchor test intermittently misses its landmark

`src/client/App.svelte` -- `toggleReading`, `scheduleFollow`, and the shared `followFrame` requestAnimationFrame handle.
`e2e/follow.spec.ts` -- the test "reading view keeps a streaming turn's original follow anchor locked", especially the assertion labelled "condensing did not immediately restore armed follow" after the double-requestAnimationFrame wait.

While executing OW-hilufa on 2026-09-02, `bunx playwright test e2e/follow.spec.ts` intermittently failed that assertion even though the test passed alone.
The miss was repeatable at the clean parent commit `4a6a731` as well as with OW-hilufa present and with its theme control hidden, so the theme change did not cause it.
Observed anchor misses were 12.75px at the parent, 36.75px in the ordered follow file, and 59.75px in the full browser suite, against the 2px tolerance.

The leading explanation from source inspection is that `toggleReading` awaits `tick()` and calls `scheduleFollow`, but `scheduleFollow` does nothing while `followFrame` is non-null.
Whether the older scheduled callback runs before or after the condensed layout then decides whether the anchor is reconciled inside the test's two-frame window.
That explanation is a finding to verify, not an established root cause.

Fix the follow scheduling race without weakening the browser assertion or increasing its wait window.
Show the existing test or a narrower structural regression test fail before the change and pass afterwards.
Run the affected test repeatedly in its ordered-file context, not only alone, because isolation is the shape that already passes.
`bun run check` and `bun run test:browser` must both pass.
