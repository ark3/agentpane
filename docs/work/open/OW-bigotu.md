---
labels: [defect]
---

# Clicking edit a second time stashes the first edit's text as your draft, so Cancel restores a message you never typed.

`src/client/App.svelte` `startEdit` (`:719-737`) and `cancelEdit` (`:739-744`)

`startEdit` records `stashedDraft: view.draft` unconditionally
(`App.svelte:735`). Called a second time while an edit is already open,
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
