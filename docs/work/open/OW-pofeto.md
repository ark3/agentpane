---
labels: [defect, browser-testing]
---

# Nothing declares `color-scheme`, so in dark mode the browser's own widgets -- scrollbars, select dropdowns, the textarea caret -- still render light against dark surfaces.

`src/client/app.css` -- the `:root` token block and the `@media (prefers-color-scheme: dark)` override at `:78`.

The app themes everything it draws itself through `--ap-*` tokens, and the dark block overrides about 25 of them.
It never tells the browser which scheme is in force: `rg 'color-scheme' src/` returns nothing.
Without that declaration the UA keeps painting its own chrome light -- the scroller on `.conversation`, the popup a `<select>` opens, the composer textarea's caret and selection, focus rings, and the form-control default backgrounds behind the `input, select, textarea, button` rule.

The fix is one declaration, `color-scheme` on `:root`, set to match whichever palette is in force.
The card is not the size of the fix: what is actually wrong is unmeasured, because nobody has looked at agentpane in dark mode in a real browser, and the list above is read off the CSS rather than observed.

## Done when

- A human or a browser test has looked at the app in dark mode and recorded which widgets were wrong, in `docs/MANUAL_TESTING.md` -- that observation is the point, and the declaration is what it justifies.
- `color-scheme` is declared and follows the palette in force, in both the system case and any explicit choice.
- A browser test asserts the computed `color-scheme` on the document element matches the palette, watched red first.
- `bun run check` and `bun run test:browser` both green.

Independent of OW-hilufa, which adds a manual theme control to the same file: this is wrong today with no toggle at all, and it stays wrong afterwards if left alone.
Whichever lands second inherits the other's shape -- if OW-hilufa has already moved the palette onto `data-theme`, the declaration goes in those blocks rather than the media query.
