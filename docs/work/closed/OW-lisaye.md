---
labels: [defect, now]
closed: done
---

# A collapsed tool card still highlights and sanitizes its whole body, so OW-64's 250000-character inline cap is paid in full for cards nobody opened

`src/client/render/tools/ToolCard.svelte` (the `open` prop and the `{@render children?.()}` inside `<details>`), `src/client/render/tools/Output.svelte` (`clipped` and `html`), `src/client/render/markdown.ts` (`renderCode`, `highlightCode`).

`ToolCard` renders its children unconditionally into the `.body` div inside the `<details>` element.
A native `<details>` only hides DOM that has already been built, so a collapsed card has paid for its body in full before the reader has expressed any interest in it.
`Output.svelte` is where that bill lands: `clipped` is a `$derived` over `truncate(text, limit)` and `html` is a `$derived` over `renderCode(clipped, language)`, which is highlight.js over the whole body followed by a DOMPurify pass over the resulting HTML, then inserted with `{@html}`.

## Why this is a defect and not a cost someone accepted

OW-64 raised `limit` from 20000 to 250000 and recorded the owner's tradeoff for doing so: "a large tool result rendering in full inline is fine in a scrollable pane with collapsed cards".
That reasoning is sound and the ceiling stays -- the owner reaffirmed on 2026-09-15 that large sizes matter when they are needed, and lowering `limit` is explicitly off the table for this card.
What it assumed is that a collapsed card is cheap, and it is not: collapsing changes what is painted and nothing about what is computed.
D5's own words in `ToolCard`'s docblock are that "the collapsed line is the primary presentation, not a degraded one", so the overwhelmingly common case is a card whose body is never looked at.

## What it costs

Measured on 2026-09-15 by calling `renderCode` directly under vitest/jsdom, a body of repeated one-line TypeScript: 243ms at 10KB, 629ms at 40KB, 2316ms at 160KB.
Split at 40KB, `hljs.highlight` is 144ms and `DOMPurify.sanitize` is 696ms, and highlight.js turns 40KB of source into 263KB of HTML.
**These are jsdom numbers and the DOMPurify half is the least trustworthy of them**, because jsdom parses HTML in JavaScript where a browser uses its native parser; treat the growth with size as the finding and the absolute figures as an upper bound.
Do not build the fix around the split -- it is recorded so that a later session asking "was sanitizing the hot half?" has the measurement, and that question is a separate card, not this one.

## The plumbing this needs first

`ToolCard` takes `open` as a one-way prop and spreads it onto the `<details>` element as `{open}`.
Native disclosure toggling never writes back through that, so Svelte does not currently know when a card is open and nothing can be gated on it yet.
`bind:open` or an `ontoggle` handler is the first move, and it is the only new machinery in scope.

Keep `open = false` as the default: this card changes when the body is built, never which cards start expanded.

## Scope

In: gate the tool body so a collapsed card does not build or highlight it, plus the toggle plumbing above.
Out: lowering `limit` (declined above); whether `renderCode` needs to sanitize its own highlighter's output at all, which is a security decision and its own card; coalescing the re-highlight for a card that is open *while* its content streams, which is the follow-on this card makes smaller rather than the problem it solves.

## Done when

A test under `src/client/render/` renders a `ToolCard` whose body is a large `Output`, asserts `renderCode` was not called while collapsed, then opens it and asserts it was.
It fails before the change on the first assertion.

Count calls, do not time them, and take the spy from `src/client/App.streaming-cost.test.ts`, which does this for `renderMarkdownWithFences` via `vi.mock` with `importOriginal` so the renderer under test stays real.
That file is OW-detepa's, filed against the same reported symptom -- streaming going sluggish -- and its opening docblock argues the counts-not-milliseconds choice; do not restate that argument here, cite it.
Note that the same file is why this went unseen: its spy wraps `renderMarkdownWithFences` only, so every `renderCode` call in a tool card is invisible to the one test guarding this area.

## Close note

Landed as 7ff4820 on `main`.

`src/client/render/tools/ToolCard.svelte` gates `{@render children?.()}` behind `{#if built}`, where `built = open || opened`, `opened` is `$state(false)`, and a new `ontoggle` handler on the `<details>` sets it when the element reports itself open.
Ever-open rather than open-now, so closing and reopening a card does not buy the same highlight twice.
`open = false` remains the default and no renderer passes `open`, so which cards start expanded is unchanged.
The `<time>` element stays outside the gate, which is what keeps the existing "stamps nothing on a card whose tool has not answered yet" assertions meaningful.

One forced adjacent edit: the `state` prop is destructured as `state: cardState`.
With a binding named `state` in scope Svelte reads `$state(...)` as a store subscription; reverting the rename reproduces `store_invalid_shape` on all three new tests, which I confirmed by hand rather than taking on report.

`src/client/render/tools/ToolCard.test.ts` counts `renderCode` calls with `vi.mock` + `importOriginal`, the spy shape `App.streaming-cost.test.ts` uses, citing that file's docblock for the counts-not-milliseconds argument rather than restating it.
Three cases: collapsed highlights nothing and renders no `pre.output`; opening highlights; reopening does not re-highlight.
The first went red before the change -- "expected spy to not be called at all, but actually been called 2 times", the second call carrying 168000 characters.

`src/client/render/tools/test-support.ts` adds `openToolCards(scope)`, used by the six existing test files that assert on body content: `App.test.ts`, `render/Block.test.ts`, `render/BlockActions.test.ts`, `render/Transcript.svelte.test.ts`, `tools/subagent.test.ts`, `tools/tools.test.ts`.
jsdom fires no `toggle` of its own when `open` is set from script, so the helper dispatches it.

`e2e/tool-card-open.spec.ts` is beyond what the card asked for and was kept deliberately.
`toggle` is not in Svelte's delegated-event list, so it is a direct listener -- but had it been delegated, the gate would be inert in a real browser while every jsdom test still passed, because the helper dispatches the event itself. Only a real click distinguishes those.

Review found three assertions that the gate had quietly made vacuous, all of the assert-absence class, and the same commit fixes them by opening the card first: `subagent.test.ts`'s "offers no control when the shell passed no way to open one" and "draws no thread control before the spawn reports an id", and `tools.test.ts`'s "still names the file when the arguments are a shape it cannot read".
Each had become unable to fail. Confirmed by mutation: replacing `{#if onopensession}` in `SubagentTool.svelte` with `{#if true}` now turns the first of them red, and did not before the fix.

`bun run check` green: 50 files, 1071 tests, 22s. `bun run test:browser` green: 21 specs, 1.1m.

Two browser-observable consequences came out of the adversarial read and are filed rather than settled here: OW-vaviza (find-in-page no longer reaches a collapsed card's output -- a decision, with a manual probe to confirm it first) and OW-hutaki (opening a card is now two height changes rather than one, unverified against scroll anchoring).
Both carry `browser-testing`.
