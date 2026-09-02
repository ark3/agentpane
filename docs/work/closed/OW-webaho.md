---
labels: [change]
---

# A finished turn leaves no trace in the session list: the row's dot simply disappears, so a background session that finished while you were elsewhere looks like one that never ran.

`src/client/App.svelte` (the session row's `{#if streaming}` block, `class="session-streaming"`), `src/client/app.css` (`.session-streaming`, and the token blocks at `:root` and the `prefers-color-scheme: dark` override), `src/client/favicon.ts`, `src/client/App.test.ts` ("takes the row's dot from the live session map rather than the listed summary").

Today the row's dot is a pure function of one boolean: the row reads `view.state.sessions[sessionKey(summary.ref)]?.isStreaming ?? summary.isStreaming` and draws `●` in `--ap-accent` while it is true.
The instant the turn ends the dot is gone, and the only surviving signal that a turn finished is the favicon badge (OW-diyuwu), which is a single tab-wide dot that names no session and clears on window focus.
So the list answers "what is running now" and nothing answers "what finished while I was reading something else".

Keep the dot after the turn ends, in red, until you switch to that session.

## The semantics, taken with the owner on 2026-09-02

**Any session, not only the ones this tab submitted.**
This is deliberately *not* `favicon.ts`'s scope: `watchSubmit` exists so the tab-wide badge only fires for turns you asked for, because a badge that names no session cannot be acted on.
The row dot names its session, so a turn another browser prompted -- or one that was already running when you attached -- is worth the same glance, and the dot describes the session rather than its authorship.

**Background sessions only.**
A session that is `state.selected` when its turn ends is one you are already looking at, so it never marks; and the mark clears when the session becomes `state.selected` (a row click publishes that through `controller.preview`).

**Client-side only, and not persisted.**
It dies with the page, like `reading` in `App.svelte`.

## The two things the obvious implementation gets wrong

Both are already solved once in `favicon.ts`, and its docblocks carry the reasoning; read them rather than re-deriving it.

**Done is a transition, not a level.**
`watchSessions` marks a session only on a false that *follows* a true, because after a submit a session reads `isStreaming:false` for a beat -- the echoed user message and the assistant placeholder land before `status:true` does.
Arm on the level and every idle session in the list is red on first paint.

**A session is re-keyed on its first prompt (D9), and the mark has to ride across.**
`watchRename` carries the favicon's watch from the old key to the new one; a mark stored under the old key is simply lost.

Keep the decision pure and testable without a DOM, the way `favicon.ts` splits: whether it grows out of `TurnWatch` or lives in a sibling module is incidental, and the two scopes differing (submitted-only versus any) is the reason a sibling may be cleaner.

## Presentation

The colour needs a token with a light and a dark value, and `--ap-danger` is not it: that token means error, and it is used by the error banner and the delete-diff background, so borrowing it makes a finished turn look like a failed one.
`--ap-success`'s dark value `#57c98a` is the favicon dot's green, for reference on how loud is loud enough.
Treat the exact red as a first cut to be judged from use, and say so in the CSS comment beside it.

Colour cannot be the only carrier: the `aria-label` on the span is `"Streaming"` today and must say something else -- "Turn finished", or similar -- when the dot is red.

## Done when

- A jsdom test in `App.test.ts` drives a session's live `isStreaming` true and then false while another session is selected, and asserts the row still carries a dot whose accessible name is the finished one, not the streaming one.
- A second test asserts that selecting that session clears it, and a third that a session which is selected when its turn ends never marks at all.
- A test asserts the level case: a mount whose session reads `isStreaming:false` and was never seen true carries no dot.
  The existing "clears the row's dot when the live session map says the turn ended" test is that case already and should keep passing unchanged; say so rather than rewriting it.
- If the mark's state lives in a pure module, its rename carry is tested there directly, against `watchRename`'s case.
- Each watched red first.
- `bun run check` passes.

Load-bearing: the transition guard, the rename carry, the background-only rule, and that the accessible name distinguishes the two dots.
Incidental: where the state lives, and the exact red.

Added a client-side per-session transition watch that retains an accessible red Turn finished marker for turns that complete while another session is selected, clears it on selection, ignores idle levels and selected/no-selection completions, and carries both observed and retained state across D9 renames. Added dedicated light/dark colour tokens and pure plus App-level coverage. New tests were observed red before implementation; the adversarial-review null-selection regression was also observed red before its guard. Verified with bun run check: 48 test files and 893 tests passed with zero TypeScript or Svelte diagnostics. Two adversarial reads found the null-selection gap and then confirmed the amended result had no blocking findings.
