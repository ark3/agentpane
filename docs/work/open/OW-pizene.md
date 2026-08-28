---
labels: [change]
---

# The session list still paints `claude` rows in the unrecognised-backend grey, though Claude Code is a supported backend.

`src/client/App.svelte` (`backendColors` / `backendColor`, just under the
comment "Keyed lookup rather than if/else"), `src/client/app.css` (the token
block at `:root` and its `prefers-color-scheme: dark` twin),
`src/client/App.test.ts`.

`backendColors` maps `codex` to `var(--ap-success)` and `pi` to
`var(--ap-accent)`, and `backendColor` falls back to `var(--ap-fg-subtle)`.
`BackendId` (`src/shared/protocol.ts`) is `"pi" | "codex" | "claude"`, so
`claude` takes that fallback: the colour that OW-44 specified for *anything
else* — an id the codebase does not know — is what a first-class backend now
gets. The fallback itself is correct and stays; this card only adds the third
entry to the map.

The owner's call, 2026-08-27: **blue**.

## The catch, and how to resolve it

`--ap-accent` *is* the blue in this palette (`#3959d9` light, `#7f9dff` dark),
and `pi` already holds it. Reusing it would make the two backends' rows
indistinguishable, which is the whole job of the swatch. So this card is not a
one-line map entry: it needs a blue that is not `--ap-accent`.

Add a token for it rather than inlining a hex in `App.svelte` — every other
entry in the map is a `var()`, and the file has no literal colours. Give it a
light value and a dark value in the two blocks, the way `--ap-success` and the
rest are paired; the dark block's values run visibly lighter than the light
block's, and matching that is what keeps the row legible on both. Separation
from `--ap-accent` is the load-bearing part; the exact hue is incidental, so
pick one and move on.

## Done

`bun run check` passes, and a new test in `src/client/App.test.ts` renders a
session list holding a `claude` session and asserts its `.session-backend` span
carries the new token and not `var(--ap-fg-subtle)`. No test in that file
asserts a backend colour today, so this is the first — write it against the
current code and watch it fail on the grey before making it pass.

This is a jsdom-visible style attribute, not layout, so `bun run test:browser`
is not implicated.
