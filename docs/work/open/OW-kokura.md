---
labels: [defect, browser-testing]
---

# The single-column layout's 1fr row is the session list, which the conversation squeezes to nothing

Under `@media (max-width: 42rem)` in `src/client/app.css`, `.shell` sets `grid-template-columns: 1fr` and a seven-row `grid-template-areas` (`"masthead" "controls" "sessions-header" "sessions" "conversation" "rail" "prompt"`) but no `grid-template-rows`, so it inherits the wide layout's `auto auto auto 1fr auto`.
The `1fr` therefore lands on the fourth row, `sessions`, and `conversation`, `rail` and `prompt` fall into implicit `auto` rows.
The banners rule OW-watajo added beside it (`.shell:has(> .banners > *)` inside the same `@media` block) deliberately resets to those same base rows, so it inherits the same shape rather than causing it.

While landing OW-watajo on 2026-09-24, the implementer measured in headless Chromium through `e2e/harness.html` at a 600x900 viewport, with the harness seeded with three turns: `.sessions` was 0px tall, with or without banners showing, because the `auto` conversation row took the whole `100vh`.
That measurement is the implementer's report and was not re-taken by the landing session.

In service of the single-column layout being usable: the load-bearing part is that the session list stays visible and the conversation, not the session list, is the row that absorbs the leftover height and scrolls.
Incidental: the exact row sizes, and whether the session list gets a cap.
Keep the banners row from OW-watajo in the same place relative to the conversation, and keep `e2e/banners.spec.ts` green.

Done when a spec in `e2e/` at a viewport narrower than 42rem, with a transcript long enough to overflow, asserts the session list has non-zero height and the conversation's box ends above the prompt's within the viewport — red against today's CSS first and green after, with `bun run test:browser` as the vehicle.
If the browser shows the session list already visible at that size, the measurement above was wrong: close this `--moot` with what the browser showed.
