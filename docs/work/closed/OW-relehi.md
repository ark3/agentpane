---
kind: change
where: '`src/client/App.svelte` composer (`:852-855`, beside Send and Stop)'
---

# Redoing the last thing you said means scrolling back to find it, which is the common case reached the long way round.

**Depends on OW-hezidi**, which builds the edit gesture and settles what
clicking edit and submitting an edit each do. This item is only the two
shortcuts to it, and if their behaviour ever diverges from scrolling up and
hitting edit on the last user message, that divergence is a defect rather than
a feature -- they are the same operation reached from a different place.

Two buttons, sited by the owner on 2026-08-19 *"under the composer near
submit/abort"*, which is `App.svelte:852-855` and deliberately not the Tools
popover: that menu holds the rare things (New conversation, Compact) and these
are the frequent one.

- **Stop and edit**, while the session is streaming.
- **Edit last message**, when it is not.

OW-hezidi renames the existing Abort button to Stop; these labels assume it.

## The one place this is not just a shortcut

OW-hezidi stops a running turn at **submit**, so that clicking edit stays free
and abandonable. This button stops at **click**, and that is not an
inconsistency to reconcile: it says so in its name, so it is not a free click
and does not need to be. It is the only exception, and OW-hezidi's rule holds
everywhere else.

A consequence worth getting right: once the abort lands, nothing is streaming,
so the composer's primary button reads **Fork** and not "Stop and fork". The
abort is asynchronous -- `controller.abort()` runs through
`view.busy === "aborting"` -- so sequence the composer fill against it rather
than beside it. Whichever order you choose, there must be no window in which
the primary button's label is a lie about what it will do.

## Done when

Each test watched red first.

1. With a streaming session, "Stop and edit" stops the turn, and the composer
   is then holding the last user message, marked, with the primary button
   reading "Fork".
2. When idle, "Edit last message" leaves exactly the state that clicking edit
   on the last user message leaves. Assert the same observable state through
   both paths, so the two cannot drift apart unnoticed.
3. Neither button offers itself when the session holds no user message, or when
   none is selected.

`bun run check` passes. Run `bun run test:browser` too if these buttons change
the composer row's layout rather than just adding to it -- jsdom cannot see
layout, and that row already carries Send, Stop and the Tools popover.

**Fixed** in c16816a: one button in the composer's action row, `"Edit last
message"` when idle and `"Stop and edit"` while streaming, rendered only when
`lastUserIndex` finds a user message to go back to -- absent rather than
disabled, matching Stop in the same row. It calls OW-hezidi's `startEdit` and
repeats none of it, so the two paths cannot drift; the anti-drift test snapshots
composer value, mark, dimming and primary label through both and compares them,
with the transcript path's snapshot pinned to a literal so the comparison
cannot pass by both paths doing nothing. Three tests in `src/client/App.test.ts`
watched red first, plus `e2e/composer-shortcut.spec.ts`. `bun run check` 764
green; `bun run test:browser` 8 green.

**The fill runs before the abort, and the abort is not awaited** -- a departure
from this item's suggested sequencing, taken under its own "whichever order you
choose" latitude and for the reason that rule names. `controller.abort()` never
clears `isStreaming`; only a server event does. So awaiting it does not make the
primary button read "Fork", and through the round trip the composer would hold
the old draft under a button reading **"Send"**, where a Ctrl-Enter prompts the
running session instead of forking it. Filling first, the label goes straight to
"Stop and fork" -- which is true rather than stale, because `forkAndSubmit`
re-checks `isStreaming` and aborts again before it forks.

Two findings recorded rather than fixed. `e2e/tools-menu.spec.ts` measures this
row but never seeds a transcript, so the shortcut does not render during it --
which is why a new spec was warranted rather than optional. And its "inside the
row" style of assertion does not bite: `.prompt-actions` sits in a content-sized
grid column, so an oversized control widens the page instead of spilling out of
a fixed box. The new spec asserts horizontal page overflow instead, verified by
forcing a 40rem min-width on the shortcut.
