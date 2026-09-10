---
labels: [change]
---

# The Send and fork buttons stay enabled while a send is in flight

Noticed by the implementer on OW-kelede, 2026-09-10, and left undone there because the card scoped the fix to the guard rather than to button state.
Not reproduced against a running backend; read off `src/client/App.svelte`.

OW-kelede put `if (view.sending) return;` at the top of `send()` in `src/client/App.svelte`, so a second press while a send is in flight now issues nothing on either the plain path or the fork path.
The composer's primary button does not say so.
Its disabled condition is still the pre-OW-kelede one — search `disabled=` in the composer's action row in `src/client/App.svelte` — which reads only the draft and the compaction, so the button stays live and a pointer press on it is refused silently.

Before OW-kelede the same was true of the plain path's `view.busy === "submitting"` guard, so this is not a regression; it is a gap that OW-kelede made worth naming, because there is now one flag that says exactly when a press will do nothing.

`view.sending` is published on `ControllerView` (see its docblock in `src/client/controller.ts`) and is already read by `send()`, so nothing new has to be plumbed.

Whether the fork/"Stop and fork" button and Ctrl/Cmd-Enter want the same treatment is part of the decision, not settled here: the keyboard path cannot be greyed out and is guarded already, and disabling a button under the pointer mid-press has its own feel.

## Done when

The button's disabled state reflects `view.sending`, and a test in `src/client/App.test.ts` asserts it — the button is enabled with a draft, disabled while a send is in flight, and enabled again once it settles; it fails before the change.

Or the decision goes the other way and the card closes `--declined` with the reason written where the disabled condition is, so the next reader stops re-asking.
