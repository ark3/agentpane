---
labels: [change]
---

# Every tab shows the same blank page icon, so agentpane is unfindable in a browser tab strip.

`index.html`, and a new `public/favicon.svg`

`index.html` sets `<title>agentpane</title>` and no `<link rel="icon">`, so the
browser draws its generic placeholder. The title alone is not enough once the
tab strip is crowded and each tab is down to an icon and a few characters.

The design, chosen 2026-08-18 and a **first cut**: a four-pane window — a
rounded square split 2x2 — with a letter `A` over it. Solid tile, mark in
contrast on top, so it reads against any tab-strip background.

Do **not** drive it from `prefers-color-scheme` inside the SVG. Support for
media queries in a `rel=icon` SVG is uneven across browsers, and a tab strip
does not reliably track the OS setting anyway, so a solid tile that works on
both is the robust shape even though `app.css:66` has a dark block. Accent is
`--ap-accent: #3959d9` (`src/client/app.css`) if you want to match the app.

## The mechanics are already clear

Verified 2026-08-18, so none of this needs rediscovering:

- `vite.config.ts` sets no `publicDir`, so Vite's default applies: a file at
  `public/favicon.svg` is copied into `dist/client`, which is the root
  `createStaticHandler` serves (`src/server/http/static.ts`). It therefore
  works in dev under Vite and in the built server without touching either.
- Bun sets the content type from the extension — `Bun.file("x.svg").type` is
  `image/svg+xml`. There is no MIME table in `static.ts` to extend.

So this is one new file and one `<link>` line.

## The risk the verdict has to settle

A 2x2 grid *and* a letter is a lot of ink for 16 physical pixels, and the
likely failure is that the panes and the `A` blur into one grey smudge — which
would defeat the entire point. Judge it at 16px in a real tab strip, not
zoomed in an editor. If it mushes, the fallback is to drop to either the panes
or the letter alone, and that is a verdict from use rather than a new item.

## Done looks like

`bun run test:browser` (the Playwright vehicle in `e2e/`, not part of `bun run
check` — OW-49) asserts `/favicon.svg` returns 200 with `image/svg+xml` and
that the `<link rel="icon">` in the served page resolves. That the icon is
*identifiable* is not something a test can assert: attach a screenshot of the
real tab strip alongside at least two other tabs, and that is the verdict.

`OW-diyuwu` overlays a status dot on this icon and depends on it landing first.

**Fixed** in eda8311: `public/favicon.svg` plus one `<link>` in `index.html`,
exactly the one-file-one-line shape the item predicted — `bun run build` puts
`dist/client/favicon.svg` in place, confirming the Vite `public/` path end to
end. `e2e/favicon.spec.ts` asserts 200 + `image/svg+xml` and that the `<link>`
resolves, and was confirmed red three ways: no `<link>`, a `<link>` pointing at
nothing, and a malformed SVG. Two findings worth keeping. Vite answers an
unknown path with `index.html` at 200, so a status assertion alone proves
nothing about the href — the content type is what separates a hit from the SPA
fallback. And a double hyphen is illegal inside an XML comment: the first cut
carried one, the icon failed to parse, and Chromium rendered nothing and said
nothing, which is why the spec decodes the image rather than trusting 200. That
trap is called out in the file, since this repo's prose uses `--` freely and
OW-diyuwu edits this same file next.

The 16px verdict, the risk the item named: the icon does **not** mush, but only
because the panes gave way. The white `A` is crisp and unambiguous; the 2x2
panes read as faint texture and resolve as panes only at ~32px. White panes were
tried first and produced exactly the predicted grey smudge, so the panes were
dropped to `#6b82e3` to put all the contrast in the letter. What reaches a tab
strip is effectively a blue tile with a white `A`. The panes-or-letter fallback
was deliberately not taken unilaterally; whether to take it is a verdict from
use.
