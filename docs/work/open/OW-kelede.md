---
labels: [defect]
---

# `forkAndSubmit` has no re-entrancy guard and still wipes a draft typed during its round trip

Surfaced by the adversarial read of OW-nasofa on 2026-09-10, confirmed by reading `src/client/controller.ts` and `src/client/App.svelte`; neither reproduced against a running backend.

OW-nasofa fixed both of these defects on `submit()` and deliberately did not touch the fork path.
The two composer paths are now inconsistent, and the fork path is the worse of the two.

**No re-entrancy guard.**
`src/client/App.svelte`, `send()`, routes to `controller.forkAndSubmit` whenever `editing` is set.
The Send button is disabled only on `!view.draft || compaction !== null`, and Ctrl/Cmd-Enter reaches `send()` without consulting even that.
`forkAndSubmit` in `src/client/controller.ts` guards on a selected session and a non-empty `view.draft` and nothing else, so two fast presses in edit mode start two whole forks — each one an abort against the parent, a `forkPoints`, a `fork`, an `attach` and a `prompt`.
The dispatched reader drove the real controller against a fake api and got two forks and two identical prompts.
This is the same defect OW-nasofa named, on the path OW-nasofa did not cover.

**The draft is wiped.**
`forkAndSubmit`'s success path publishes `publish({ draft: "", ...(intent === selectionIntent ? { error: null } : {}) })`.
OW-mifuki gated the error clear on the intent and left the draft clear unconditional, with a docblock above it giving the reason: the draft is global, so a user who clicked away mid-POST would otherwise be looking at another session with already-sent text under a Send button.
That reason survives the fix this card wants, and the docblock has to move with the code rather than be left standing against it.
`submit()`'s rule — clear only when `view.draft` still equals the text that was sent — covers the click-away case too, because clicking away does not change the draft; what it stops is the *typed* replacement being wiped.
The fork's round trip is four requests deep where a plain submit is one, so the window in which a user can type the next prompt and lose it is far wider here.

**It is now destructive, not just wasteful.**
OW-mifuki landed a disarm in `src/client/App.svelte`, `send()`: a submit that never reached the backend takes its follow and badge arming back down.
A second fork press resolves null and disarms — and on a renaming backend both presses' `armedKey` listeners have followed onto the same fork, so the second press's disarm strips the arming off the *first* fork's live turn.
The user gets no badge for a turn they did start.
OW-mifuki guarded the plain path against this with `if (!edit && view.busy === "submitting") return;` in `send()` and deliberately did not extend it to the edit path, because a guard there would be inventing a re-entrancy rule the controller does not have.
This card is where that rule gets written, and the guard belongs in `forkAndSubmit` rather than in `send()`.

**`view.busy` is not a sound in-flight signal, and the guard should not lean on it.**
`busy` is one global slot. `abort()` publishes `"aborting"` then `"idle"` in its `finally`, and `attachAndSelect` publishes `"attaching"` then `"idle"`; either clears it while a submit's POST is still outstanding.
Concretely: prompt a session over a slow POST, watch the turn start streaming (D2 lets SSE precede the POST response), press Stop, and `busy` goes `aborting` then `idle` — after which both `send()`'s guard and `submit()`'s own `busyIs("submitting")` let a second prompt through for the same session, and its failure disarms the first.
So this card wants a flag `submit` and `forkAndSubmit` own between them, not another read of `busy`; fixing that is what makes both guards sound, and OW-nasofa's along with them.

## Done when

- A test in `src/client/controller.test.ts` calls `forkAndSubmit` twice while the fake api's `fork` (or `prompt`) promise is held open and asserts one fork; it fails before the change.
- A test publishes a new draft while that promise is held, resolves it, and asserts the new draft survives; it fails before the change.
- A test presses send twice in edit mode, fails the second, and asserts the first fork's badge arming survives; it fails before the change.
- A test aborts mid-prompt and asserts a second submit for that session is still refused; it fails before the change.

## Load-bearing

The guard OW-nasofa put in `submit()` reads `busyIs("submitting")`, and `forkAndSubmit` publishes that same `"submitting"`.
Whatever mechanism OW-dinuwu leaves behind for keeping `busy` from being stomped by a `sessions-changed` re-list is the mechanism this card should reuse, rather than inventing a second one.
