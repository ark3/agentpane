---
labels: [question, browser-testing]
---

# Find-in-page no longer reaches a tool card's output, because OW-lisaye stopped building a collapsed body the browser used to auto-expand into

Surfaced by the adversarial read at OW-lisaye's finished work, 2026-09-15, and not weighed when that card was written.

`src/client/render/tools/ToolCard.svelte`, the `{#if built}` gate around `{@render children?.()}` and the `built` docblock directly above it.

A native `<details>` is reachable by the browser's own find-in-page: Chromium auto-expands a closed one when Ctrl-F matches text inside it.
That worked here for free, because the body was in the DOM whether or not the card was open.
OW-lisaye stopped building a collapsed body, so a reader searching the transcript for a filename or an error string that appears only inside a tool's output now gets no match on a page that visibly contains it once the card is opened by hand.

Nothing in `src/`, `docs/` or `e2e/` mentions find-in-page, so nobody has taken a position on it either way.

## The decision to make

Three dispositions, and which one is right is the owner's call:

- Accept it, and say so in the `built` docblock, where the next reader meets the gate.
  The gate is what makes a 250000-character inline cap affordable, and a transcript search that reaches only summary lines may be what the owner wants anyway.
- Recover it cheaply if some `hidden="until-found"` shape can hold a *built* body out of the layout without highlighting it -- which it cannot, because building is the cost, so this almost certainly requires giving the search its own path rather than the browser's.
- Give search its own path, which is a feature and would be its own card.

## First, confirm it

The claim is read off the HTML spec's behaviour, not measured here.
Probe it in the Chromium `bun run test:browser` already drives: seed a transcript with a collapsed tool card whose output carries a distinctive string, and check whether the string is findable.
Note that Playwright has no find-in-page API, so this is a manual observation in a real browser, recorded in `docs/MANUAL_TESTING.md` with the Chromium version -- not an `e2e/` spec.

If the probe shows Chromium never auto-expanded these cards in the first place, close this card recording that, because then OW-lisaye took nothing away.

## Done when

The decision is written in the `built` docblock in `ToolCard.svelte` -- accepted, or recovered by a named mechanism -- and the probe that settled it is in `docs/MANUAL_TESTING.md` naming the browser version it ran on.
