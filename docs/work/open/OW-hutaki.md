---
labels: [unverified, browser-testing]
---

# Opening a tool card is now two height changes rather than one, and nothing has checked what scroll anchoring does with the second

Surfaced by the adversarial read at OW-lisaye's finished work, 2026-09-15. No misbehaviour has been observed; this card exists because nothing has looked.

`src/client/render/tools/ToolCard.svelte` (the `ontoggle` handler and the `{#if built}` gate) against `src/client/App.svelte`'s follow-mode height tracking -- the place that remembers a height and compares it to `el.scrollHeight` to detect a shrink -- and `.conversation` in `src/client/app.css`, which carries CSS scroll anchoring (OW-47).

Before OW-lisaye, clicking a tool card's `<summary>` changed the conversation's height exactly once, synchronously, inside the browser's own disclosure toggle.
Now the browser opens an empty `.body` and fires `toggle`, and Svelte fills that body in a later flush: two height changes, the second of them outside the browser's toggle.

A reader who opens a large tool card sitting above the viewport is where a difference would show, since that is what scroll anchoring exists to absorb.

## Why jsdom cannot settle it

Per AGENTS.md, jsdom sees no layout, no scroll anchoring and no real scroll-event timing, so the jsdom tests for OW-lisaye are silent on this by construction.
`e2e/tool-card-open.spec.ts` does not cover it either: it waits for `pre.output` to become visible and asserts nothing about scroll position.

## Done when

An `e2e/` spec in the shape of `e2e/follow.spec.ts` seeds a transcript long enough to scroll, with a large collapsed tool card above the viewport, records the scroll position, opens that card by clicking its `<summary>`, and asserts what the position does.

Whichever way it comes out is the result: if the position holds, the spec is the guard and this card closes `--done` on it; if it jumps, that jump is a defect and the fix is a new card, with this spec as its red test.
