---
kind: defect
where: '`src/client/App.svelte:19`, `src/client/render/Markdown.svelte`, `src/client/render/Block.svelte`'
---

# One SSE event costs ~92ms because the deep `$state` proxy re-parses every settled markdown block in the transcript — for events belonging to a session that is not even on screen.

Reported live 2026-08-19: the UI goes sluggish while streaming, and *most*
annoying when the session causing it is not the one being read. Measured the
same day with `e2e/perf-harness.ts` against a production build (`c1b8805`), the
cost of one event, median of 60:

| transcript / sidebar | selected streams | background streams |
| --- | --- | --- |
| 15 msgs, 2 sessions | 9.0ms | 7.6ms |
| 180 msgs, 2 sessions | 75.5ms | **77.1ms** |
| 180 msgs, 400 sessions | 91.5ms | **91.9ms** |
| 15 msgs, 400 sessions | 21.3ms | 21.6ms |

An event for a background session costs the same as one for the session on
screen, in every scenario. Cost tracks the size of the **selected** transcript,
not the size of the delta.

A V8 profile over the background case attributes it: **47%
`renderMarkdownWithFences`** (39% DOMPurify, 7% marked), 5% `buildDiff` via
`EditTool`, the rest Svelte's dirty-check traversal. All of it is waste — a
`MutationObserver` over `.conversation` counts **zero** DOM mutations for those
events, because the re-parse yields byte-identical HTML that Svelte's `{@html}`
then declines to write.

## Why it re-parses, which is not what D5 assumes

`view` is a deep `$state`, and `publish()` replaces the whole `ControllerView`
object per event. `proxy()` short-circuits only on values that are *already*
proxies (`node_modules/svelte/src/internal/client/proxy.js:39`), so a fresh root
proxy rebuilds the whole tree and every child reassignment reads as a change.

D5 says "only the tail block re-parses", and the docblock in `Markdown.svelte`
says the same. Both are wrong today, for a reason worth writing down because it
is invisible at the call site: `text={block.text}` in `Block.svelte` creates
**no derived boundary**. The compiled `prop()` reads the parent getter directly,
so `Markdown.svelte`'s `$effect` is subscribed straight to the `{#each}` item
source and is marked *dirty*, not *maybe-dirty*, when that source is reassigned
— and effects do not value-compare. Svelte's derived equality check
(`reactivity/deriveds.js:396`) spares `Output.svelte`'s `renderCode`, which sits
behind a `$derived` returning an unchanged string; nothing spares an effect.

## What to do

`$state.raw` at `:19`. The controller never mutates in place and `view.draft` is
read-only in the markup (`value=`, not `bind:`), so the swap is sound: unchanged
messages keep object identity, `selectedSession` returns `===` the same object
when another session updates, and the derived equality check then stops
propagation at the top. Measured with that one change: 91.5 -> 8.0ms selected,
91.9 -> 3.3ms background, and DOMPurify, marked and `diff` leave the profile
entirely. `bun run check` and `bun run test:browser` both pass with it.

Two things to weigh rather than assume. **`$state.raw` is a load-bearing
constraint, not an optimisation** — it silently stops working the moment
something mutates `view` in place, and nothing enforces that; say so at the
site. And the missing derived boundary is the deeper defect: a `$derived` around
each block, or memoising the parse by source string, would make the renderer
robust to a future deep-`$state` reader rather than merely un-triggered by this
one. Judge whether that is worth it once `$state.raw` has landed and been
re-measured; do not do both blind.

## Done when

A test in `src/client/` fails before and passes after, asserting call counts —
not milliseconds, which are a coin toss on a loaded machine. `vi.mock` over
`./render/markdown.ts` with `importOriginal`, counting
`renderMarkdownWithFences`, then ten upserts for a non-selected session through
`reduceServerEvent` and the real `App.svelte`. Verified 2026-08-19 to
discriminate: **160 calls on `main`, 0 with the fix**, over a 8-turn selected
transcript. `App.test.ts` already drives `reduceServerEvent` directly (`:348`)
and holds a `FakeController` to copy — mind OW-42, which is exactly the warning
that that fake does not publish the way the real controller does.

Worth a second assertion for the selected session, where the invariant is not
zero but *constant*: the same transcript streamed at 8 turns and at 24 turns
must produce the same call count. Measured at 10 deltas into the selected
session: **170 on `main`, 20 with the fix**.

Re-measure with `bun e2e/perf-probe.ts` and record the numbers in
`docs/MANUAL_TESTING.md`. It needs a production build served statically — the
dev server puts Svelte's `get_stack`/`get_error` tracing at 47% of samples and
roughly doubles every figure above, which is also why the app feels worse under
`bun run dev` than it does shipped. Recipe in `vite.perf.config.ts`.

Leaves OW-jineli (the sidebar sort, the next cost down) and OW-luzipe (the wire)
untouched; neither blocks this.

**Fixed** in a73cd67: `view` at `src/client/App.svelte:19` is `$state.raw`, with
a docblock saying the constraint is load-bearing and dies silently on any
in-place mutation. `src/client/App.streaming-cost.test.ts` counts
`renderMarkdownWithFences` through a `vi.mock`/`importOriginal` spy over ten
deltas driven through the real `reduceServerEvent`, and was watched red first:
**160 -> 0** for a non-selected session, and for the selected one **171 -> 11**
at 8 turns against **491 -> 11** at 24 turns, which is the constancy claim.
`FakeController` was not reusable (OW-42) since the publish is what is under
test; the test carries its own `PublishingController` mirroring
`controller.ts`'s `publish()`. Re-measured with `bun e2e/perf-probe.ts` against
a production build and recorded in `docs/MANUAL_TESTING.md`: at 180 messages
and 400 sessions, 92.6 -> 7.3ms selected and 91.2 -> 5.5ms background, with DOM
mutation counts unchanged either side. D5 and `Markdown.svelte`'s docblock, both
of which claimed the tail-block confinement the deep proxy was breaking, now say
what makes it true. The derived-boundary question the item raises is left open,
as the item asked.
