---
kind: change
where: '`index.html`, and a new `public/favicon.svg`'
---

# Every tab shows the same blank page icon, so agentpane is unfindable in a browser tab strip.

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
