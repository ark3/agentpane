---
labels: [defect, now]
closed: done
---

# `forkAndSubmit` ignores a selection made during its round trip, and a failed send leaves follow and the badge armed on the parent

Both traced by reading on 2026-09-09, neither reproduced; the tests named below are the reproduction.

`src/client/controller.ts`, `forkAndSubmit`: it bumps `selectionIntent` and never compares it back after its awaits, where `attachAndSelect` in the same file does (`if (disposed || intent !== selectionIntent) return false`).
A click on another session during the fork's attach and prompt is yanked back to the fork.
Then `src/client/App.svelte`, in `send()`'s edit branch, runs `rekeySession(armedKey, sessionKey(now))` against whatever `now` is, so the parent's scroll, follow, and badge state moves onto an unrelated session if the user did switch.

`App.svelte`, `send()`: `armFollow(...)` and `armBadge()` run before the request, and neither is disarmed when `controller.submit()` or the fork rejects.
The next stream on that session from any source, another tab or a resumed turn, engages follow and can badge the tab for a turn this tab never sent, which contradicts the rule in `src/client/favicon.ts` that the badge marks turns this viewer started.

## Done when

- A test in `controller.test.ts` starts `forkAndSubmit`, selects another session while the fake fork is held, releases it, and asserts the selection is the second session; it fails before the change.
- A test in `App.test.ts` makes the prompt reject and asserts a subsequent stream on that session neither engages follow nor badges; it fails before the change.

## Close note

Landed as b415574 on `main`.

**Half one — the stale intent.**
`forkAndSubmit` in `src/client/controller.ts` now captures `intent = selectionIntent` at entry, re-checks `disposed || intent !== selectionIntent` after every await (abort, forkPoints, fork, attach), and reassigns `intent = ++selectionIntent` at the bump where the fork legitimately becomes the newest intent.
A click on another session during any of those windows is now honoured instead of yanked back.

**Half two — arming without sending.**
`submit()` now resolves `Promise<boolean>`.
That was not optional: `submit()` swallows its rejection and publishes it as `view.error`, so its old `Promise<void>` resolved identically on success and failure and `App.svelte` had no way at all to observe a failed submit — the card's own done-condition was unreachable without it.
It also covers the quieter third case OW-nasofa introduced, where `busyIs("submitting")` refuses and issues nothing.
`src/client/favicon.ts` gained `watchAbandon`, the pure counterpart to `watchSubmit`, and `send()` in `App.svelte` gained `disarmSubmit(key)`, called whenever nothing was sent.
`send()` tracks `armedKey` through a rename in flight with a scoped `controller.onRename` listener, so on Pi — where the fork renames — the disarm names where the arming actually sits rather than the click-time key.

**What review changed, and it was not small.**
The first cut re-checked the intent *after* `await api.prompt` too, and returned false there.
That was a regression the card never asked for: the prompt had genuinely landed, so a user who clicked away mid-POST lost the badge for a turn this tab did start, and — worse — the draft was never cleared, leaving the text they had just sent sitting in the composer over an unrelated session under a button reading "Send".
Returning plain `true` instead was not available either: `send()`'s re-key read `view.state.selected` back, so `true` would have moved this tab's follow and badge arming onto whatever the user had clicked.

So `forkAndSubmit` now resolves `Promise<SessionRef | null>` — the ref the prompt landed on.
The draft clears unconditionally once the prompt lands; only the `error: null` stays gated on the intent, which is its real purpose, since a session clicked to in that window may have raised an error of its own.
`send()` re-keys off the returned ref and never off `state.selected`.
`FakeController.forkResult` in `App.test.ts` became a ref for the same reason.

Two tests came out of that review, both watched red first:

- `controller.test.ts` "reports the fork it landed on, and clears the draft, when the click comes after the prompt" — `expected false to deeply equal { backend: 'codex', … }` against the pre-review commit.
- `App.test.ts` "badges the fork it landed on, not a session clicked mid-fork" — `expected '/favicon.svg' to be '/favicon-badged.svg'` with the re-key restored to reading `state.selected`.

The card's own two, also watched red by this session and by the implementer:

- `controller.test.ts` "abandons a fork whose selection was overtaken by a click mid-flight" — `expected true to be false`.
- `App.test.ts` "disarms follow and the badge when the prompt fails…" — `expected 60 to be 50` for the follow half, and `expected '/favicon-badged.svg' to be '/favicon.svg'` for the badge half when the follow assertion is relaxed so it cannot mask it.

Two test fakes had drifted from the real controller and only this change exposed them; both fixed here.
`FakeController.submit` never dropped `busy` back to idle where the real one does in a `finally`, and the Pi fork test's `onForkAndSubmit` fired `renamed` without publishing the fork's selection, which the real `forkAndSubmit` does via `applyAttached` before it resolves.
Running the new production code against the old fakes fails six tests, so neither edit is cosmetic.

`bun run check` green at 995, and `bun run test:browser` run by hand at 20/20 because this touches follow-mode arming in `App.svelte`.

**Left standing, deliberately.** `send()`'s new `if (!edit && view.busy === "submitting") return;` guards the plain path only.
Extending it to the edit path would invent a re-entrancy rule `forkAndSubmit` does not have, and `view.busy` is not a sound in-flight signal anyway — an abort or an attach clears it mid-POST.
Both are written up on OW-kelede, which now also carries the consequence that the disarm makes a fork double-press destructive rather than merely wasteful.

Also noticed and not filed separately: when the new intent guard trips after `api.fork` succeeded, the forked session is left on the backend with nothing attaching or cleaning it up.
Pre-existing in shape — a rejected `api.attach` did the same — but a plain click now reaches it.
