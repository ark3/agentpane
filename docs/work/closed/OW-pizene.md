---
labels: [change]
---

# Backend colours are borrowed status tokens: `codex` wears "success" green, `pi` wears the app's accent, and `claude` wears the unknown-id grey.

`src/client/App.svelte` (`backendColors` / `backendColor`, just under the comment "Keyed lookup rather than if/else"), `src/client/app.css` (the token block at `:root` and its `prefers-color-scheme: dark` twin), `src/client/App.test.ts` (the test named "color-codes the backend badge per backend, with an unrecognised backend id falling back to grey").

Two problems, and the second is the reason this card is not a one-line map entry.

**`claude` has no colour.** `backendColors` maps `codex` and `pi` only, and `backendColor` falls back to `var(--ap-fg-subtle)`.
`BackendId` (`src/shared/protocol.ts`) is `"pi" | "codex" | "claude"`, so a supported backend renders in the grey OW-44 chose for ids the codebase does not know.

**The two colours that exist are borrowed from the wrong axis.** `codex` is `var(--ap-success)` and `pi` is `var(--ap-accent)`.
Neither token means what it is being used for: green here is not "this succeeded" and the accent is not "this is the emphasized thing" — both are standing in for *identity*, which is a different axis from status and emphasis.
The tell is already visible in the row: `.session-streaming` (`app.css:188`) is `var(--ap-accent)` because the streaming `●` genuinely is emphasis, so backend and liveness draw from one token while meaning unrelated things.
Restyling emphasis would silently repaint a backend, and vice versa.

## What is being coloured

`App.svelte` renders the backend's **name as text** — `<span class="session-backend" style="color: {backendColor(...)}">` — and `backendColor` tints those letters.
OW-44 and the existing test both call it the "backend badge"; there is no badge styling behind that name, so expect the word and expect it to mean coloured letters.
`.session-backend` carries no rule of its own beyond `.session-backend-attached { font-weight: 700; }`; it inherits `.session-meta`'s small size.

Small thin glyphs are why the three hues have to be far apart rather than merely distinct: two neighbouring indigos separate poorly at this size, where the same two would be obvious as filled squares.

## The fix — an identity scale of its own

Add three tokens to `app.css`, in both the `:root` block and the dark block, paired the way `--ap-success` and the rest already are (the dark values run visibly lighter; matching that is what keeps the name legible on both).
Name them for the backend, so the map is a lookup from an id to the token of the same name and there is nothing left to interpret:

- `--ap-backend-codex` — **green**
- `--ap-backend-claude` — **blue**
- `--ap-backend-pi` — **purple**

Hues assigned by the owner 2026-08-27; green / blue / purple sits the three roughly 120° apart, which is what survives being rendered as small text.
Seed the values by *copying* what is already on screen rather than aliasing it — `#157f4b` / `#57c98a` for green and `#3959d9` / `#7f9dff` for blue keep `codex` and `claude` in familiar territory, and `#8b2fa0` / `#d08ce8` (`--ap-syn-keyword`'s pair) is a reasonable purple.
Copying is the point: a `var(--ap-success)` alias would re-create the coupling this card exists to remove.
Exact hues are incidental once the three are clearly green, blue and purple.

`backendColors` then holds all three ids and no borrowed token.
Keep `backendColor`'s `?? var(--ap-fg-subtle)` fallback exactly as it is — with every id in the union mapped it covers only ids that do not exist yet, which is what OW-44 built it for, and "subtle foreground" is the honest meaning for an unknown.

An alternative shape, considered and not chosen: a generic categorical scale (`--ap-cat-1…3`) that backends are assigned from, which avoids naming backends in CSS.
Rejected as premature at three fixed ids — say so in the close note if implementing changes your mind.

## Done

`bun run check` passes, and the existing test in `src/client/App.test.ts` is amended rather than joined by a second one.
It already builds a list of `pi`, `codex` and a `"future" as BackendId` session and asserts the three inline colours off `.session-backend`.
Add a `claude` session; assert `pi`, `codex` and `claude` each carry their own `--ap-backend-*` token, and that `future` is still `var(--ap-fg-subtle)` — that last case is what keeps the fallback covered.

Run it before touching `App.svelte` and watch it fail on all three backend assertions: `codex` on the success token, `pi` on the accent, `claude` grey.

Grep `--ap-accent` and `--ap-success` afterwards to confirm the session list no longer appears among their consumers; the remaining hits should all be emphasis and status, which is the separation this card is buying.

These are jsdom-visible style attributes, not layout, so `bun run test:browser` is not implicated.

Added an identity scale of its own: `--ap-backend-codex` / `--ap-backend-claude` / `--ap-backend-pi` in `src/client/app.css`, in the `:root` block and its dark twin, as literal hex copies rather than `var()` aliases so the coupling this card existed to remove does not survive.
`backendColors` in `src/client/App.svelte` now maps all three ids to their same-named tokens; `backendColor`'s `?? var(--ap-fg-subtle)` fallback is untouched and still covers only ids that do not exist yet.
`claude` had been rendering in that unknown-id grey and now has a colour.
Hues are the owner's green / blue / purple, seeded by copying what was on screen: `#157f4b`/`#57c98a`, `#3959d9`/`#7f9dff`, `#8b2fa0`/`#d08ce8`.

The existing test "color-codes the backend badge per backend, with an unrecognised backend id falling back to grey" was amended, not joined: it gained a `claude` session, and the three backend assertions were shown red first against the old map — `var(--ap-accent)` for pi, `var(--ap-success)` for codex, `var(--ap-fg-subtle)` for claude — before the fix took them green. `future` still asserts `var(--ap-fg-subtle)`.
`bun run check` passes (865 tests). Grepping `--ap-accent` and `--ap-success` afterwards, the session list no longer consumes either; the remaining hits are all emphasis and status, and `.session-streaming` is now the row's only accent user, which is the separation this card bought.

The generic `--ap-cat-1…3` alternative did not look better on implementing: naming backends in CSS is what keeps the map a bare id-to-token lookup with nothing to interpret.
Committed as 651185f on main.
