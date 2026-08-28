---
labels: [change]
---

# A turn that finishes while the tab is in the background goes unnoticed until you happen to look at it.

`src/client/` (a new favicon module, wired from `App.svelte`), `public/`, `e2e/`

When a turn *this tab submitted* finishes while the tab is not focused, badge
the favicon. Clear it the moment the tab regains focus.

Decided by the owner on 2026-08-18, replacing this item's original premise --
a badge for sessions blocked on an approval `ServerRequest`. That is not
buildable: nothing in the client can answer such a request, so the state can be
entered and never left, and a badge that latches on until reload is not a
signal. `OW-bijera` carries that gap.

## What is settled

**Not focused means `document.hasFocus()`,** window focus, not
`document.visibilityState`. The two disagree in one case -- agentpane visible
on a second monitor while you type in an editor -- and that case badges. A dot
you did not need costs a glance; one that never appears costs the feature.

**A turn finishing with the tab focused does nothing at all.** No flash, no
transient dot.

**Only sessions this tab submitted to.** A session can stream for other
reasons: it was mid-turn when you attached, or another browser prompted it.
`controller.submit()` (`src/client/controller.ts`) is the only submit path, so
that is where the set is joined.

## The two traps

**Done is a transition, not a level.** After a submit, the session still reads
`isStreaming:false` for a beat. The docblock on `runTurn` in `e2e/harness.ts`
records the ordering a live Pi turn was observed to produce, from `OW-27`'s
close note: the echoed user message and the assistant's placeholder both land
while `isStreaming:false`, and only then does `status:true` follow. Arm on a
false that follows a true, or the badge fires the instant you submit.

**A session's ref can change mid-turn** (D9). `submit()` already threads the
rename through `renameListeners`/`onRename` for its own error handling; the set
of sessions this tab is waiting on has to survive the same rename, or the badge
misses the one turn it was armed for.

An aborted or errored turn counts as done -- first cut, on the reasoning that
you asked for something and it stopped. Say so where the code decides it, and
revisit from use.

## How it is drawn

Two static files and a swap of `href` on the `<link rel="icon">`:
`public/favicon.svg` plus a badged sibling. Not a data-URI SVG or a
canvas-rendered PNG built at runtime, which is what the original cut of this
item proposed and flagged as unverified across browsers. Swapping between two
served files is the well-supported path and needs no probe. The cost is two
files carrying the same markup; put a comment in each naming the other. If a
static swap turns out not to repaint, *that* is the finding, and the data-URI
route is the fallback.

An SVG file cannot read a CSS custom property from the page, so the colour is
copied the way `public/favicon.svg` already hardcodes `#3959d9`. `#57c98a`
(`--ap-success` dark, `src/client/app.css`) reads on the blue tile where
`#157f4b` (the light one) will not. First cut, verdict from use. And no em dash
inside an XML comment -- `public/favicon.svg`'s own comment says what that
costs.

`e2e/harness.html` declares no `<link rel="icon">`, where `index.html` does.
Either add one or have the module create the element when it is absent. Both
pages must reach the icon through the same code, or the browser test proves
nothing about the app.

## Done looks like

`bun run test:browser` submits a synthetic turn through the harness with the
page unfocused, asserts the `href` changed once the turn completes, and asserts
it reverts on focus.

**Probe first:** whether headless Chromium can give the harness page a real
`document.hasFocus() === false`. Opening a second page in the same context and
bringing it to the front is the usual lever. If it cannot, the browser test
shrinks to the repaint alone, the focus decision moves to a jsdom unit test
over the pure function (transition plus focus in, badge state out), and the
commit message says which way it went and why.

Playwright here is Chromium-only -- `playwright.config.ts` declares no
`projects` and only chromium is installed. Firefox is a one-off manual check
recorded in `docs/MANUAL_TESTING.md`, not a second project; a second project
doubles the runtime of every browser test to cover one claim.

Plus a screenshot of the tab in both states. Whether the dot is noticeable at
16px is a verdict from use, not an assertion.

**Fixed** in f146744: `src/client/favicon.ts` holds the decision as a pure
reducer and `App.svelte` arms it at the two submit sites, beside `armFollow`.
`e2e/badge.spec.ts` drives a real turn through the real controller with the
window unfocused and asserts the `href` swaps to `/favicon-badged.svg`, then
back on focus. Both traps the item named are pinned by a test that was watched
to fail: deleting the transition guard in `watchSessions` reds exactly "does
not badge on the `isStreaming:false` that still stands just after a submit",
and dropping `watchRename` reds the D9 case. The probe the item asked for came
back negative -- headless Chromium reports every page focused, so the focus
decision is proven in jsdom and the harness stubs `document.hasFocus`; the four
levers tried are tabulated in `docs/MANUAL_TESTING.md`, along with the Firefox
153.0 one-off confirming Gecko swaps both ways and fetches the badged file.
What is still unobserved is the tab strip itself, since no engine available
here has one: `OW-yiduso` carries that and the 16px legibility verdict.
