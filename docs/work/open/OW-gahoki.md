---
labels: [defect, browser-testing]
---

# Reading-view condensing races an older follow frame, so the browser anchor test intermittently misses its landmark

`src/client/App.svelte` -- `toggleReading`, `scheduleFollow`, and the shared `followFrame` requestAnimationFrame handle.
`e2e/follow.spec.ts` -- the test "reading view keeps a streaming turn's original follow anchor locked", especially the assertion labelled "condensing did not immediately restore armed follow" after the double-requestAnimationFrame wait.

While executing OW-hilufa on 2026-09-02, `bunx playwright test e2e/follow.spec.ts` intermittently failed that assertion even though the test passed alone.
The miss was repeatable at the clean parent commit `4a6a731` as well as with OW-hilufa present and with its theme control hidden, so the theme change did not cause it.
Observed anchor misses were 12.75px at the parent, 36.75px in the ordered follow file, and 59.75px in the full browser suite, against the 2px tolerance.

## Verdict (2026-09-02): the frame-race explanation is REFUTED; the miss is `reconcile`'s designed bottom cap

The leading explanation from source inspection was that `toggleReading` awaits `tick()` and calls `scheduleFollow`, but `scheduleFollow` does nothing while `followFrame` is non-null, so a borrowed in-flight frame could reconcile against a discarded layout.
Instrumented Playwright runs refuted it: a pending requestAnimationFrame always fires after the microtask that flushes the condensed DOM, so even a deliberately forced coalesced frame reconciled against the layout actually on screen.
The same probes settled the OW-56 ordering question: Chromium's shrink-clamp scroll event arrived before the followFrame callback in every run, and the handler took the keep-anchor branch, so the guard holds on the throttled path.

The actual cause is geometry.
Condensing removes the live turn's thinking and tool chrome (241px in the fixture) from below the anchor, and until the streamed body alone fills a viewport, `reconcile`'s cap `Math.min(bottom, anchorTop)` pins the pane at the scroller's bottom, leaving the anchor `clientHeight - contentBelow` short of flush -- 470 - 410.25 = 59.75px, the recorded miss to the hundredth.
The 12.75 -> 36.75 -> 59.75px spread quantizes to whole text lines, set by how many 12ms chunks landed before the pause: chunk-count variance, not layout-race jitter.
The anchor stays armed and reconciled throughout; the test's two-frame window was asserting flush, a promise `reconcile` never made, so the test moved (commit `bea8968`, cherry-picked to main): the condense-side assertion takes the `Math.min(offset, bottomGap)` form the compact-tail test in the same file already uses, and the expand-side and settled assertions stay strict.

## Why it bites the test and not a reader

`follow.spec.ts:207` pauses the synthetic stream (`harness.pace(160, 1_000)`), and its comment says why: so only the toggle can restore the anchor, rather than a later SSE upsert running the ordinary reconciliation and making the toggle path pass without doing anything of its own.
That is good test design, and it is also the whole reason this is fatal here.
In use the stream is still running, the next token schedules another `reconcile` within about 160ms, and the anchor snaps back invisibly; with the stream paused there is no next token, so a reconcile request swallowed by an in-flight `followFrame` is swallowed permanently.

So the requirement is not "reconcile sooner".
It is that a caller with a specific layout in mind must **own** a reconcile rather than borrow whatever frame happens to be in flight.
`scheduleFollow`'s coalescing is correct for the caller it was written for -- one pending frame per streamed token, the D5 pattern -- and a fix that removes the coalescing outright is fixing the wrong thing.

## The trap

The comment at `App.svelte:472-475` says why the armed branch takes the throttled path at all: reconciling in the same tick replaces `state.height` before Chromium delivers the shrink-generated scroll event, so `handleConversationScroll` mistakes that clamp for a reader scroll and clears the anchor.
That guard is OW-56's, and the obvious fix -- reconcile immediately -- walks straight into it.
Cancel-and-reschedule is probably safe, since a fresh frame still lands after the tick, but the ordering against the clamp event has never been established and "probably" is doing real work in that sentence.
Establish it rather than assuming it, and if the shrink event turns out to arrive after the rescheduled frame, that is the finding and the fix has to go somewhere else.

`OW-jomubi` built the branch being fixed here; its close note carries the armed-follow rationale and the red magnitudes its own regressions were shown at.

## Done when

- The leading explanation above is either confirmed or refuted, and **whichever it is, the card's file records which**, because the next reader of this area will otherwise re-derive it.
  If it is refuted, the actual cause is recorded here in its place before any fix lands.
- The anchor guarantee holds: after a toggle in either direction, with the stream paused, the armed anchor is reconciled against the layout that is actually on screen.
  That guarantee is non-negotiable.
  Which side moves to satisfy it is not: if the two-frame window turns out to be asserting a promise the throttle never made, correcting the test is a legitimate outcome, and the card closes on the guarantee rather than on the product having been the wrong side.
- The existing test or a narrower structural regression test is shown failing before the change and passing afterwards.
- The affected test is run repeatedly in its ordered-file context, not only alone, because isolation is the shape that already passes.
- `bun run check` and `bun run test:browser` both pass.
