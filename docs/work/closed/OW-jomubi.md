---
labels: [change, browser-testing]
---

# Toggling reading view drops the scroll position wherever the height change leaves it, so the passage you were reading is gone the moment you flip the view.

`src/client/App.svelte` -- the toggle at `<button ... onclick={() => (reading = !reading)}>Reading view</button>`, and `anchorTop`, `navTargets`, `applyScrollTop`, `reconcile`, `handleConversationScroll`, `navigate`, `SessionScroll`.
`src/client/render/transcript.ts` (`condense`), `e2e/follow.spec.ts`.

The toggle's handler is the whole of what happens today: it flips `reading` and nothing else.
Reading view then elides every tool call, tool result and thinking block, the transcript's height changes underneath a `scrollTop` that was never renegotiated, and the reader lands somewhere arbitrary.
OW-51 recorded this as a first cut -- "scroll position may jump when toggling and pinning is not wanted yet" -- and the owner overturns it from use on 2026-09-02.

Keep the reader where they were across the flip, in both directions.

## The two cases want different answers

**Follow armed.**
Nothing new is needed: `reconcile` already re-pins the pane against `[data-index]`, and `condense` preserves original indices precisely so that keeps resolving.
The gap is only that flipping `reading` never calls it -- the toggle is not in the `$effect` that drives `scheduleFollow` -- so the anchor stays unpinned until the next SSE event happens to arrive.

**Follow disengaged.**
This is the case the card is for, and it needs a landmark carried across the flip:

- The landmark is a **user turn**, and it must be: `condense` never elides user messages, so they are the only entries guaranteed present in both views.
  A tool card cannot serve, because in reading view it does not exist.
  `navTargets` already computes the pivot this wants -- the first user turn at or below the viewport top -- so reuse it rather than writing a second traversal.
- Record the landmark's **delta from the viewport top** (`anchorTop(el, node) - el.scrollTop`), never an absolute `scrollTop`.
  A `scrollTop` means a different place in the two views, which is the entire defect.
- **At the very top, with no user turn above the viewport, hold `scrollTop` where it is** rather than inventing a landmark.
  Decided with the owner on 2026-09-02.

## The detail that is load-bearing, not stylistic

The restore goes through `applyScrollTop`.
That is what registers the move as programmatic so `handleConversationScroll` ignores the resulting event; move the scroller any other way and toggling the view disarms follow exactly as a manual scroll does.
Read the position back afterwards the way `navigate` does, and write it to the session's `SessionScroll.top`: the browser clamps to the real range, and a stale `top` is what gets restored when you switch back to this session.

The flip must be awaited before the landmark is re-found -- `tick` is already imported in `App.svelte`.

## Why jsdom cannot settle it

`await tick()` sees the DOM, not settled layout, and markdown rendering is frame-throttled (D5), so the landmark's true offset can move after the tick resolves.
Chromium also clamps a too-large `scrollTop` on the shrink and fires `scroll` for it; the guard in `handleConversationScroll` exists because reading view eliding chrome mid-stream produced exactly that event once already (OW-56).
Neither is visible in jsdom.

## Done when

- A browser test in `e2e/follow.spec.ts` (or a focused sibling) seeds a transcript with tool and thinking chrome above and below the viewport, scrolls to a mid-transcript position with follow disengaged, toggles reading view on and back off, and asserts the landmark user turn sits within a few pixels of its original screen offset after each flip.
- A test asserts the toggle does not disarm follow: with follow armed, flipping in both directions leaves the pane pinned to its anchor.
- A test covers the top case: at `scrollTop` 0 with no user turn above the viewport, the flip leaves the position unchanged.
- Each watched red first -- the pinning ones by removing the restore, and the follow one by routing the restore around `applyScrollTop`, which is the mistake the code invites.
- `bun run check` and `bun run test:browser` both green.

Load-bearing: a user turn as the landmark, the delta rather than an absolute position, the restore going through `applyScrollTop`, and the hold-still rule at the top.
Incidental: where the landmark capture lives, and the pixel tolerance the browser test allows.

Independent of OW-nuzipo, which adds a streaming tail line to the same view and touches the same scroll handler; neither blocks the other.

Reading view now carries the nav pivot user turn and its viewport delta across condensed and expanded renders, preserves absolute top, and explicitly reconciles an armed follow through the programmatic-scroll path.
Chromium coverage holds removable tool and thinking chrome on both sides of a disengaged viewport, checks both toggle directions and absolute top, and pauses streaming to prove each armed-follow toggle restores its anchor itself.
The regressions failed red at 481.3125px without landmark restoration, 120.25px without toggle reconciliation, and 344.078125px when restoration bypassed `applyScrollTop`.
`bun run check` passed 893 tests across 48 files, and `bun run test:browser` passed all 14 Chromium tests.
