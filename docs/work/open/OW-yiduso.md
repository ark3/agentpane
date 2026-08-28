---
labels: [question]
---

# Nothing has watched a browser actually repaint the tab icon when the favicon href is swapped.

`public/favicon-badged.svg`, `src/client/favicon.ts`, `docs/MANUAL_TESTING.md`

`OW-diyuwu` shipped the turn-done badge as two served files with the `href` on
`<link rel="icon">` swapped between them, on the reasoning that a static swap
is the well-supported path. Every check behind it is headless and none of them
has a tab strip:

- `e2e/badge.spec.ts` asserts the `href` attribute changed, not that anything
  was drawn.
- The Firefox one-off in `docs/MANUAL_TESTING.md` observed Gecko issuing a
  network request for the badged file on the swap. That is the closest proxy
  available headlessly, and it is still not a pixel.

So the item's own escape hatch is untested: "If a static swap turns out not to
repaint, *that* is the finding, and the data-URI route is the fallback."

Two things settle this and both are a human at a real browser, not automation.
Open agentpane, submit a turn, click away to another window, and watch the tab.
Then: does the icon change at all, and is a dot at 16px enough to notice
without hunting for it? The colour (`#57c98a`) and the dot's size (r=2.7 on the
16-unit grid, cut out of the top-right corner) were both marked first cuts in
`OW-diyuwu`, to be judged from use.

Worth checking in Safari too if a Mac is to hand; it is the engine most likely
to differ, and neither `OW-diyuwu` nor `OW-ropuwo` has ever run there.
