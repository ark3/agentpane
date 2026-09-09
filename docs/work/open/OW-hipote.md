---
labels: [deferral]
---

# `App.svelte` is 1300 lines with no style block and three seams it is not using: the follow engine, the session list, and the composer

Measured on 2026-09-09: `src/client/App.svelte` is 1303 lines, about 1040 of script and 260 of markup, and `src/client/App.test.ts` is 2205 lines mounting the whole shell for every case.

The seams, each of which touches one rune or none:

- The scroll, follow, and nav-rail engine, from `handleConversationScroll` through `navigate` and the two effects that drive `navDisabled`, is a plain module with one reactive output.
  OW-47 and OW-yorita are its history and its open edge.
- The session list, the `<nav class="sessions">` block plus `sessionLabel`, `firstUserText`, `backendColor`, `basename`, and the sort-and-filter deriveds, is a component with `summaries` in and a selection out.
  OW-jineli memoised its sort.
- The composer, the `<form>` block plus `editing`, `startEdit`, `cancelEdit`, `send`, and `handlePromptKeydown`, is a component with the draft and the controller in.
  OW-hezidi and OW-relehi built most of it.

This is a deferral because nothing is broken and each of those cards landed without the split.
The cost is in the test file, and it is paid on every client card.
Take it when the next card touches two of the three at once, or when `App.test.ts` crosses a threshold the owner names.
Do not take it as a drive-by inside another card: `docs/DESIGN.md` D5 records that `$state.raw` on `view` is what confines re-parsing to the tail block, and a split that passes `view` through props has to keep that property, which `App.streaming-cost.test.ts` measures.

## Done when

The three files exist, `App.svelte` holds only wiring, and `App.streaming-cost.test.ts` and `App.sort-cost.test.ts` report the same counts as before the split.
