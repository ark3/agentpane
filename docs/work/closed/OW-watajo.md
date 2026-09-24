---
labels: [defect, browser-testing]
closed: done
---

# The shell's banners have no grid area, so the error, notices and warnings auto-place below the prompt

`.shell` in `src/client/app.css` names five rows in `grid-template-areas` and every cell of them is claimed: masthead, then controls, sessions-header and sessions down the left beside `conversation` and `rail`, then `sessions prompt prompt`.
The shell-level banners that `src/client/App.svelte` renders between the `<nav>` of sessions and the conversation carry no `grid-area`: the error banner (`<p class="error" role="alert">`), the backend notices (`<ul class="notices" role="status" aria-label="Backend notices">`, OW-tujiya), the unrestored-model warning (`<p class="warning" role="status" aria-label="Unrestored model">`, OW-pubeju), and the "blocked on a request agentpane cannot answer" warning.
With no free cell in the template, CSS grid auto-placement should put each one into an implicit row after the prompt, one per cell, so the first lands in the narrow sessions column under the composer.
This was read from the CSS on 2026-09-24 while landing OW-pubeju and has not been observed in a browser; the single-column layout under the `@media` block beside it (`grid-template-areas: "masthead" "controls" ...`) has the same shape of problem, and OW-60's close records the same trap for the rail ("has to appear in the single-column `grid-template-areas` or it auto-places").

In service of every banner being read where the conversation is: the load-bearing part is that each of these elements sits above or beside the conversation, spanning its column, in both the wide and single-column layouts.
Incidental: whether that is one new named area holding a wrapper around all four or an area per element, and the exact spacing.

Done when a spec in `e2e/` renders a session carrying at least one of these banners and asserts its bounding box sits above the prompt's and within the conversation column's horizontal extent, red against today's CSS first and green after; `bun run test:browser` is the vehicle, since jsdom does no layout.
If the browser shows the banners already placed where the conversation is, the reading above was wrong: close this `--moot` with what the browser showed.

## Close note

The reading was right, and worse than it read: in headless Chromium at 900x700, before the fix, the auto-placed banner rows collapsed the conversation column to 2px wide while the rail stretched to 548px, and at 600x900 every banner sat below the composer.

The four shell banners (error, backend notices, unrestored-model warning, blocked-request warning) now sit inside one `<div class="banners">` in `src/client/App.svelte`, with `grid-area: banners` in `src/client/app.css`.
A `.shell:has(> .banners > *)` rule adds the row only while a banner shows, because an empty track still costs a `gap`: wide, it is `"controls banners ."` above the conversation, and the controls span it; single-column, `banners` goes between `sessions` and `conversation`.
The empty wrapper is `display: none`, and with no banner showing the template is exactly the old one.

`e2e/banners.spec.ts` covers both layouts: with banners, each one's box ends above the prompt and the conversation and lies within the conversation's horizontal extent; with none, the conversation keeps its old position.
The landing session reran it against main's CSS and markup and watched both banner tests fail, then saw it green after the change; the implementer also showed that making the row unconditional turns the no-banner tests red.
`e2e/harness.ts` gained `showBanners()`, which re-snapshots the transcript carrying all four.
`bun run check` passed (1336 tests), and so did `bun run test:browser` (26).
AGENTS.md now names the `.shell` grid among the reasons to run the browser suite by hand.

Filed OW-kokura: the single-column layout's `1fr` row is `sessions`, not `conversation`, a defect that predates this card.
