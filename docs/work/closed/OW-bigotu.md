---
labels: [defect]
closed: done
---

# Clicking edit a second time stashes the first edit's text as your draft, so Cancel restores a message you never typed.

`src/client/App.svelte` `startEdit` (`:947-964`) and `cancelEdit` (`:992-996`)

`startEdit` records `stashedDraft: view.draft` unconditionally
(`App.svelte:962`). Called a second time while an edit is already open,
`view.draft` is no longer the draft the *first* edit displaced -- it is the
text `startEdit` itself loaded from the message. So the original draft is gone
after two clicks, and `cancelEdit` puts back the other message's wording
instead, which reads as the composer inventing text.

To see it: type something, click edit on message A, click edit on message B,
click Cancel. What comes back is A's text. What OW-hezidi promised is what you
typed -- *"An existing draft is clobbered. Hitting edit with something already
typed loses it. Stash it and restore on cancel"*, in its "Constraints that will
bite".

Landed in ae881b5 and missed by review: every OW-hezidi test drives at most one
`startEdit` per render, so nothing exercises the second call.

Re-targeting an open edit is a real gesture and stays allowed -- OW-relehi's
"Edit last message" is a second entry point to the same function and can be
clicked mid-edit. The fix is that the stash is captured once per *mode*, not
once per click: keep the existing `stashedDraft` when `editing` is already
non-null.

## Done when

Watched red first, in `src/client/App.test.ts` beside the existing
`"cancels an edit on a click..."` test: with a draft typed, edit one message,
edit a second, cancel -- the composer holds the typed draft, and the mark and
the dimmed tail are gone. It must fail on the code as it stands today.

## Amended 2026-09-11

Line numbers only, checked against `main` before dispatch: `startEdit` is at
`:947-964`, `cancelEdit` at `:992-996`, and the unconditional
`stashedDraft: view.draft` at `:962`. The quoted phrases and the fix are
unchanged.

One case the card does not name and the fix covers for free: `editLastMessage`
(`:984`) is a third entry point to `startEdit`, and it has no disabled
condition, so it can be clicked while a send is in flight. That is a second
`startEdit` call like any other and wants the same answer.

## Close note

Fixed in `0534e16` (implemented on `card/OW-bigotu` as `c9e69ec`, cherry-picked onto `main`).

`startEdit` in `src/client/App.svelte` now captures the stash once per edit *mode* rather than once per click:

```
const stashedDraft = editing ? editing.stashedDraft : view.draft;
```

Re-targeting an open edit still works and was never in question -- the test asserts both halves, that the composer takes on the newly targeted message's text and that the `.msg.editing` mark moves, before it asserts Cancel restores what was typed.

## Verification

`src/client/App.test.ts`, "keeps the draft the first edit displaced when a second edit re-targets it (OW-bigotu)".
Watched red by the dispatching session against the unfixed line, not only by the implementer: expected `half-written note`, received `first draft` -- the card's own symptom, the first edit's loaded text coming back in place of the typed draft.
Green after, with `bun run check` clean on `main`: 1013 tests, 48 files.
`bun run test:browser` is not implicated; nothing here touches layout, scrolling or the Popover API.

## Amended before dispatch

Line numbers only, on 2026-09-11: the card cited `startEdit` at `:719-737` and `cancelEdit` at `:739-744`, which had drifted to `:947-964` and `:992-996`, and `stashedDraft: view.draft` to `:962`.
The quoted phrases and the named fix were unchanged, so this was amendable staleness rather than drift that kills intent.

## Noticed and not done

The `editing` state docblock says `stashedDraft` is "whatever the composer held when the edit displaced it".
That still reads true, but "when the mode began" is what the code now means; the new comment at `startEdit` carries the nuance and the docblock was left alone as adjacent work.

`editLastMessage` is a third entry point into `startEdit` with no disabled condition, so it can be clicked repeatedly and mid-send.
The stash now survives that, which is the point of this fix.
What it does still do is re-fire `controller.abort()` on each click while streaming.
That was examined during this session and judged harmless -- `forkAndSubmit` re-checks `isStreaming` and aborts again before it forks, so a repeated abort costs a redundant request and nothing else -- and deliberately not filed.
