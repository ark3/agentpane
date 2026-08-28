---
labels: [change]
---

# Give the three backends three hues in the session list: `claude` sits on the unrecognised-backend grey, and the blue it wants is the one `pi` is holding.

`src/client/App.svelte` (`backendColors` / `backendColor`, just under the
comment "Keyed lookup rather than if/else"), `src/client/app.css` (the token
block at `:root` and its `prefers-color-scheme: dark` twin),
`src/client/App.test.ts`.

`backendColors` maps `codex` to `var(--ap-success)` and `pi` to
`var(--ap-accent)`, and `backendColor` falls back to `var(--ap-fg-subtle)`.
`BackendId` (`src/shared/protocol.ts`) is `"pi" | "codex" | "claude"`, so
`claude` takes that fallback: the colour OW-44 specified for *anything else* —
an id the codebase does not know — is what a first-class backend now gets. The
fallback itself is correct and stays; every id in the union gets an entry, and
the fallback keeps covering the ids that do not exist yet.

## What is being coloured

`App.svelte` renders the backend's **name as text** — `<span
class="session-backend" style="color: {backendColor(...)}">` — and
`backendColor` tints those letters. OW-44 and the existing test both call it
the "backend badge"; there is no badge styling behind that name, so expect the
word and expect it to mean coloured letters. `.session-backend` carries no rule
of its own beyond `.session-backend-attached { font-weight: 700; }`; it inherits
`.session-meta`'s small size. The `●` elsewhere in the row is the streaming
dot, a separate signal that says nothing about the backend — though it draws
from the same token, which the note below picks up.

That the glyphs are small and thin is why the hues have to be far apart rather
than merely different: two neighbouring indigos separate poorly at this size,
where the same two would be obvious as filled squares.

## The assignment, decided by the owner 2026-08-27

- `codex` — **green**, `var(--ap-success)`. Already correct; do not touch it.
- `claude` — **blue**, `var(--ap-accent)` (`#3959d9` light, `#7f9dff` dark).
- `pi` — **purple**, and it moves off `--ap-accent` to make room.

The move is the point of the card, not a side effect: `--ap-accent` is this
palette's only blue, so `claude` can have it only if `pi` gives it up. Green /
blue / purple then puts the three roughly 120° apart, which is what survives
being rendered as small text.

Add a purple token pair rather than inlining a hex — every entry in the map is
a `var()` and `App.svelte` holds no literal colours. Give it a light value and
a dark value in the two blocks the way `--ap-success` and the rest are paired;
the dark block's values run visibly lighter than the light block's, and
matching that is what keeps the name legible on both. `--ap-syn-keyword`
(`#8b2fa0` light, `#d08ce8` dark) is the hue to aim near, but do not reuse that
token: it belongs to syntax highlighting, and chrome borrowing from it welds
two unrelated things together. The exact hue is incidental once it is clearly
purple.

`--ap-accent` is the app's general accent — pressed buttons, the edit banner,
`Message.svelte`'s focus ring, links in `Markdown.svelte` — so handing it to
`claude` does not give `claude` a private colour, it points `claude` at the
colour the app already uses for emphasis. That is the status quo `pi` has held
since OW-44 and the owner's call keeps it, so implement it as written; it is
noted here only so the next reader does not "fix" it. One consequence is worth
seeing before you decide it is fine: `.session-streaming` (`app.css:188`), the
`●` in these same rows, is also `var(--ap-accent)`, so a streaming `claude`
row will show name and dot in one colour.

## Done

`bun run check` passes, and the existing test in `src/client/App.test.ts` —
"color-codes the backend badge per backend, with an unrecognised backend id
falling back to grey" — is amended rather than joined by a second one. It
already builds a list of `pi`, `codex` and a `"future" as BackendId` session
and asserts the three inline colours off `.session-backend`. Add a `claude`
session to that list, change the `pi` expectation from `var(--ap-accent)` to
the new purple token, and assert `claude` is `var(--ap-accent)`. `codex` on
`--ap-success` and `future` on `--ap-fg-subtle` both stay as they are, and the
`future` case is what keeps the fallback covered.

Run it before changing `App.svelte` and watch it fail on both new assertions —
`claude` grey, `pi` on the accent.

These are jsdom-visible style attributes, not layout, so `bun run test:browser`
is not implicated.
