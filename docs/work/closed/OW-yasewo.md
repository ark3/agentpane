---
labels: [defect]
closed: done
---

# `recover()` wipes the view error and stomps `busy`, the same defect OW-dinuwu fixed for the re-list

Surfaced by the adversarial read of OW-dinuwu on 2026-09-10 and confirmed there by reading; not reproduced against a running backend.

OW-dinuwu stopped a broadcast-driven `sessions-changed` re-list from touching `busy` and `error`.
`recover()` in `src/client/controller.ts` is the same defect through a different door, and it is untouched.

It publishes `busy: "attaching", error: null` unconditionally, and nothing user-driven ever reaches it.
Its only caller is the `for (const ref of result.recover) void recover(ref)` line in `onEvent`, and `result.recover` is non-empty only from the two `acceptsSequence` failures in `src/client/session-state.ts` — the `renamed` branch and the `upsert`/`status`/`error`/`request` branch.
Both mean the client dropped an SSE event, so the trigger is a sequence gap after a reconnect, never a gesture.

Three things a user loses:

- **The one-prompt-at-a-time guard.** *Already fixed elsewhere, 2026-09-10 — see the amendment note below.*
  Mid-prompt `busy` was `"submitting"`; a gapped event fired `recover`, which overwrote it with `"attaching"`, and the next Ctrl-Enter walked past `if (busyIs("submitting")) return;` in `submit()` and issued a duplicate prompt.
  `submit`'s own `finally` guard stopped matching too, so `recover`'s `finally` was what restored `"idle"`.
- **An unread error.** A failed compact or abort message is wiped by `error: null` with no gesture behind it.
- **Cross-session bleed.** `busy` is one global slot and `recover` is per-session, so recovering session B writes "Opening session…" over what the user is doing in session A.

## Done when

- A test in `src/client/controller.test.ts` publishes an error, delivers a sequence-gapped event that drives `recover`, and asserts the error survives; it fails before the change.
- A sibling holds a prompt open, drives `recover` the same way, and asserts a second `submit()` still issues no second `POST prompt`.
  This one **passes before the change** and is a regression guard, not a red-first test — see the amendment note.
  Write it anyway: nothing else pins `recover` against the send guard, and the guard moved once already.
- `recover`'s `finally` still publishes `busy: "idle"` when it finds `"attaching"`, which is how it can also cut short a real `attachAndSelect`'s status.
  Whatever the fix is, it covers the `finally` as well as the opening publish.

## Amended 2026-09-10, executing

OW-kelede landed `sending: boolean` on `ControllerView` — a flag `submit` and `forkAndSubmit` own between them, raised before the first await in each and lowered in each `finally`.
All three re-entrancy guards now read that flag instead of `busy`, precisely because `busy` is one global slot that other operations clear out from under a live POST.
So `recover`'s stomp can no longer let a duplicate prompt through: the first of the three losses above is closed, by a different door than this card expected.

What is left is real and untouched: the unread error wiped by `error: null`, and the cross-session status-line bleed.
Neither depends on the guard.

## Load-bearing

Reuse whatever OW-dinuwu left behind rather than inventing a second mechanism: `refreshSessions` there took a `surface: boolean`, with a `refreshSurfacing` flag so a Refresh press joining a silent listing still owns the error slot.
`recover` has no user-initiated caller at all, so it may not need the parameter — simply not touching `busy` and `error` may be the whole fix.
Check what the status line loses if `recover` stops writing `"attaching"`: the reader did not, and it is the one thing that might argue for keeping a surfaced variant.

## Close note

Landed as ebf2bcc, `fix: stop a background recovery wiping the error and the status line`.

`recover()` in `src/client/controller.ts` now writes neither `busy` nor `error`: the opening `publish({ busy: "attaching", error: null })` is gone, the `finally` that published `busy: "idle"` is gone entirely, and the `catch` no longer reports the failure.
A docblock on `recover` carries the whole reason, so a reader who arrives at a background attach that reports nothing is told that is the point rather than "fixing" it back — the same job `refreshSessions`'s docblock does for OW-dinuwu.

No `surface` parameter.
OW-dinuwu needed one because `refreshSessions` has two callers and one of them is a gesture; `recover` has exactly one caller, `onEvent`, and no gesture reaches it, so a parameter with one call site would have been a speculative abstraction.

The implementer found a third door the card did not name: even with the opening publish removed, a *successful* recovery still wiped the error through `applyAttached`, which published `error: null` unconditionally.
That is now inside the existing `select ?` spread beside `preview: null`.
Verified in review that `applyAttached(…, false, …)` has exactly one caller — `recover` — and that both `select: true` callers, `attachAndSelect` and `forkAndSubmit`, already publish `error: null` at their own start, so gating it costs those paths nothing.

Two judgments the card asked for, both recorded at the code:

- **Status line.** Losing "Opening session…" during a background repair costs nothing the user can act on, and keeping it cost two things: `busy` is one global slot naming the user's *own* last gesture, so a gap on session B wrote "Opening session…" over the "Sending prompt…" the user was watching in session A — false, not merely uninformative — and the `finally`'s `busy: "idle"` fired on `view.busy === "attaching"` without checking whose attach it was, cutting a genuine `attachAndSelect`'s status short for the rest of its duration.
- **Error slot.** The `catch` should not seize it either. An error with no gesture behind it is unattributable, and the remedy is automatic: the next event for that session gaps again and retries, and a Refresh re-lists regardless. There is no `console` call anywhere in the client, so there was no logging channel to route it to without inventing one.

Both red-first tests confirmed red by the dispatching session against `ebf2bcc~1`'s `controller.ts`: `expected null to be 'Select a session before submitting a …'` and `expected 'idle' to be 'submitting'`.
The third test — a second `submit()` during a recovery issues no second POST — passed before the change and is labelled in the source as the regression guard it is; OW-kelede had already closed that loss by moving the send guard onto `sending`, and the card was amended before dispatch to say so.
`bun run check` green: 0 type errors, 1002 tests.

Noticed and left alone: `applyAttached` with `select: false` still moves `state.selected` onto the returned ref when the requested ref is the selected one — rename-shaped and apparently intentional, but it means a background recovery can rewrite the selected ref.
Not filed; it is a reading of intent, not an observed defect.
