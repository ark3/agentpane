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
`forkAndSubmit`'s success path publishes `publish({ draft: "", error: null })` unconditionally.
`submit()` now clears the draft only when `view.draft` still equals the text that was sent.
The fork's round trip is four requests deep where a plain submit is one, so the window in which a user can type the next prompt and lose it is far wider here.

## Done when

- A test in `src/client/controller.test.ts` calls `forkAndSubmit` twice while the fake api's `fork` (or `prompt`) promise is held open and asserts one fork; it fails before the change.
- A test publishes a new draft while that promise is held, resolves it, and asserts the new draft survives; it fails before the change.

## Load-bearing

The guard OW-nasofa put in `submit()` reads `busyIs("submitting")`, and `forkAndSubmit` publishes that same `"submitting"`.
Whatever mechanism OW-dinuwu leaves behind for keeping `busy` from being stomped by a `sessions-changed` re-list is the mechanism this card should reuse, rather than inventing a second one.
