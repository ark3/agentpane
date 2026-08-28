---
labels: [change]
---

# Boldfacing the backend name does not read as attached: replace it with a gutter stripe on the row.

Decided by the owner 2026-08-27, after living with the cue OW-65 shipped.
Boldface on the backend name is not perceptible in place, and the row needs a marker that reads while scanning a long list.

## Why the current cue fails, which is what constrains the replacement

`class:session-backend-attached={summary.status === "attached"}` in `src/client/App.svelte` sets `font-weight: 700` via `app.css`'s `.session-backend-attached` rule.
That is a *relative* cue: weight is only perceptible against an adjacent lighter sample, and attached rows are usually not adjacent to anything you are comparing them with.
It sits on the worst substrate in the row for that judgement — `.session-meta` is `--ap-text-2xs` (11px) in `--ap-fg-subtle`, the smallest and lowest-contrast text there is here.

So the replacement must be **absolute** — present or absent — rather than more or less of something.

## The channels that are already spoken for

Do not reach for any of these; each already means something else in this row, and doubling one up is how a list stops being readable:

- Colour on `.session-backend` is about to mean *backend identity* (OW-pizene, open).
- Row background and border mean *this is the row you are viewing*: the global `button[aria-pressed="true"] { border-color: var(--ap-accent); background: var(--ap-accent-soft); }` rule applies to `.session-select`.
- The `●` in `--ap-accent` means *streaming*. OW-65 warned specifically against conflating attached with streaming, and a second dot in the same row is that confusion made visual.
- Weight is what this card is retiring.

## The change

Mark the attached row with a stripe on its leading edge, keyed off `summary.status === "attached"` on the `.session-select` button rather than on any span inside it — the whole row is the thing that is attached, and the meta line is already full.

Draw it as an inset `box-shadow` or a `::before`, **not** `border-left`: `button[aria-pressed="true"]` already owns `border-color`, and a stripe drawn as a border would be overwritten on the selected row, which is exactly the row you are most likely to be looking at.

Give it a token of its own rather than borrowing one.
Not `--ap-accent`, which selection and streaming both already use.
Not a backend identity token, for the reason OW-pizene exists.
Attached is a status, so a status-shaped name is right; what it must not be is a colour whose established meaning is something else — `--ap-success` is not available for this on the same grounds, because attached is not success.

Width, colour and inset are a **first cut**, to be judged on screen and not in this card.
Keep it modest for now: D12's reclamation is designed but unbuilt (OW-33 idle reaper, OW-34 LRU cap N=16, both open), so attached is currently unbounded and accumulates for the life of the server process — a loud marker would be on a growing share of rows.
It can get louder once those land and attached is at most 16 of a ~973-session corpus (D9).

Remove `.session-backend-attached` and its `class:` binding rather than stacking the stripe on top of the boldface.
A cue nobody can perceive is not a cue, and leaving it means two rules to keep in step for one piece of state.
This supersedes the third of OW-65's four changes; that card is closed and stays as the record of what was built then.

The state should also be announced, not only drawn.
The row's accessible name is `aria-label={label}` and says nothing about attachment, so the old cue was invisible to a screen reader and a stripe alone would be too.
Carry it in the accessible name or in visually-hidden text — the cheapest thing that makes the state readable without pixels.

## What this does not fix

The marker will still be stale, because `summary.status` comes from `#liveOverlay` at list-read time and only `sessions-changed` re-reads it.
That is OW-furinu (open) and is not this card's job.
Attach does emit `sessions-changed`, so attaching shows up promptly today; when OW-33/34 land, eviction must emit it too or the stripe will claim attached long after the subprocess is gone.
Whatever happens here, note that requirement in OW-33 and OW-34 so it is not discovered after the fact.

## Done

`bun run check` passes, and the existing test in `src/client/App.test.ts` — "boldfaces the backend badge only for an attached session" — is rewritten rather than joined by a second one, since its subject is being replaced.
It already renders an attached `pi` summary alongside a detached `codex` one; keep that setup, and assert the stripe's marker class is on the attached row's `.session-select` and absent from the detached one.
Rename the test to say what it now checks.
Run it before the change and watch it fail.

Assert the class, not a computed style: jsdom does not lay out or resolve an inset shadow, and the visual verdict is the owner's at `bun run dev`, not a test's.
For the same reason `bun run test:browser` is not implicated — this is a static style, not layout, scrolling or the Popover API.

Confirm by hand with at least one attached and several detached sessions in view, including the case where the attached row is also the selected row, which is where a border-based implementation would silently lose the stripe.

The boldface is gone — `.session-backend-attached` and its `class:` binding are both removed — and an attached row now carries a gutter stripe instead: `class:session-attached={summary.status === "attached"}` on the `.session-select` button, drawn in `app.css` as `.session-attached { box-shadow: inset 3px 0 0 0 var(--ap-attached); }`.
Inset shadow, not `border-left`, for the reason the card gave, and the docblock at the rule records it: `button[aria-pressed="true"]` owns `border-color`, so a border stripe would vanish on the selected row.
Hand-reasoned and confirmed in the source: the selected rule assigns only `border-color` and `background`, nothing else assigns `box-shadow` to `.session-select`, so a selected attached row keeps the accent border and soft fill *and* draws the stripe inside them.

New token `--ap-attached`, its own status-shaped name rather than a borrowed one: `#0f7f8f` light, `#4fbfd0` dark.
Teal because it collides with nothing already meaningful in the row — the backend hues are green/blue/purple (OW-pizene), `--ap-accent` is selection and streaming, `--ap-success` green, `--ap-warning` amber, `--ap-danger` red.
Width, colour and inset are the first cut the card asked for and are deliberately quiet while attached is unbounded; the docblock says so and names OW-33/OW-34 as what would let it get louder.

Announced as well as drawn, in the accessible name: `aria-label` becomes `${label} (attached)` on an attached row.
Visually-hidden text inside the button would have been silent — `aria-label` wins over content — so the label is both the cheapest thing and the only one that works without re-rigging the row's naming.

The test "boldfaces the backend badge only for an attached session" was rewritten, not joined, as "stripes the row of an attached session, and says so in its accessible name": same attached-`pi`/detached-`codex` setup, asserting the marker class on the `.session-select` and the two accessible names, class rather than computed style since jsdom resolves neither the token nor the inset shadow.
Shown red first (`expected false to be true` on `classList.contains("session-attached")`).
`bun run check` passes (865 tests); `test:browser` is not implicated.

Collateral, and worth knowing: `App.test.ts`'s `summary()` helper defaults `status: "attached"`, so three unrelated lookups by row accessible name met the new "(attached)" suffix.
They were made prefix matches that still say what they meant rather than freezing the suffix into tests about something else.
Left undone deliberately: that helper's attached default now makes most fixtures attached without meaning to be, and a detached default would be truer to the corpus.

The card's conditional was already discharged before this session (01c4fc8): OW-33 and OW-34 each carry the note that eviction must leave the client's `status` corrected, OW-33 by emitting for itself and OW-34 under `attach`'s existing emit.
Committed as 19447d2 on main.
