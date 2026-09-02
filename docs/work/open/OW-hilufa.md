---
labels: [change, browser-testing]
---

# Dark mode is whatever the OS says and nothing else: there is no way to run agentpane dark on a light desktop, or light on a dark one.

`src/client/app.css` (the `:root` token block and the `@media (prefers-color-scheme: dark)` override at `:78`), `src/client/App.svelte` (`<header class="masthead">`), `src/client/main.ts`, `index.html`.

Every colour in the app is a `--ap-*` token, and the dark palette is one media block overriding about 25 of them -- surfaces, text, accent, danger, the diff and syntax palettes, the backend-identity colours (OW-pizene) and the attached marker (OW-lepoki).
That centralisation is the good news; the gap is that `prefers-color-scheme` is the only input, so the reader has no say.

Add a theme control.

## Decisions taken with the owner on 2026-09-02

**It goes in the masthead**, right of `<h1>agentpane</h1>`, which is already `display: flex; justify-content: space-between` and holds only the status line.
That header is the app's one piece of session-independent chrome, and theme is its one session-independent preference; it is also on screen when nothing is selected, which the composer is not.
`.session-controls` was rejected despite being the cheaper home: its `aria-label` is "Session controls", and a global appearance preference is not one.
The Tools popover was rejected for OW-relehi's own reason -- that menu holds rare per-session *actions*, and it renders only when a session is selected.

**Three states, not two: light, dark, and system.**
Today's behaviour is "system", so a two-state toggle has no way back to it and silently makes the OS setting dead.
A small `<select>` labelled Theme sits naturally beside the two selects the chrome already has; a cycling button works too, but only if its accessible name says which state it is in.

**No persistence.**
The choice dies with the page, exactly like `reading` (OW-51), and every load starts at system.
This is deliberate: it keeps `localStorage` out of a client that has never had it, and it is what makes the flash-of-wrong-theme problem disappear rather than needing solving.
Do not add persistence as a kindness.

## Implementation, and the one thing to check in a browser

Resolve system to a concrete value in `main.ts` at module scope, before `mount`, and always write `data-theme="light" | "dark"` on `<html>`; then `app.css` carries two flat attribute-selected blocks and no media query, with a `matchMedia` listener so a system change while the tab is open still tracks when the state is system.
That shape keeps the dark palette written exactly once, which matters: the alternative -- keeping the media query as the no-attribute default and adding an override block beside it -- states 25 tokens twice and they will drift.

The risk it buys is a flash: `main.ts` is a deferred module script, so a paint can in principle land before it runs and show `--ap-bg-sunken`'s light value.
`index.html` is thirteen lines with an empty `#app`, so there is very little to paint and this may never be observable.
**Whatever the answer, record it**: watch a cold load in a real dark-mode browser, and if a flash is visible, fall back to the media-query default with a duplicated dark block and say in the CSS comment that the duplication is paying for the flash.

## Done when

- A jsdom test in `App.test.ts` asserts the control's three states each write the expected `data-theme` on the document element, and that the system state reflects `matchMedia`'s answer.
- A test asserts a system-preference change while the control is in the system state re-resolves the attribute, and that it does *not* while the control is on an explicit choice.
- A browser test asserts the dark palette actually applies by reading a computed colour off a rendered element with `data-theme="dark"` set -- which is a side benefit worth having: nothing today exercises the dark block at all, since `bun run test:browser` runs headless Chromium at its default scheme.
- Each watched red first.
- `bun run check` and `bun run test:browser` both green.

Load-bearing: three states, the masthead, no persistence, the dark palette written once, and no flash on a cold load.
Incidental: whether the control is a select or a cycling button, and its exact label.

OW-pofeto covers the unset `color-scheme` beside this; the two touch the same file and neither blocks the other.

## Source check before execution

OW-pofeto landed first on 2026-09-02 and added `color-scheme: light` to `:root` plus `color-scheme: dark` to the system dark media-query block.
When this card flattens the palette into `data-theme` blocks, those declarations move with their matching palettes so browser-owned controls continue to follow the resolved theme.
