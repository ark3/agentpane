---
labels: [defect]
---

# Seven arms of the Codex mapping have never been executed by a test, so their output is whatever was typed the day they were written.

`src/server/adapters/codex/reducer.test.ts`, against `src/server/adapters/codex/mapping.ts` (`userInputToContent` `:139-166`, `imageGeneration` `:454-462`, `imageView` `:463-472`)

Confirmed 2026-08-19: none of `imageGeneration`, `imageView`, `localImage`,
`audio`, `localAudio`, `skill` or `mention` appears anywhere in
`src/server/adapters/codex/*.test.ts`. `reducer.test.ts` covers the types
DESIGN's table names plus `mcpToolCall`, `dynamicToolCall` and `webSearch`;
these seven were added alongside them and never pinned.

Five are content-block variants inside `userInputToContent` (`:139-166`), which
degrade to a text stand-in -- `[image: <path>]`, `[audio: <url>]`,
`[skill: <name>]`, `@<name>`. Two are item types producing an assistant message
(`:454-472`). Every one is a pure function of its input, so a test is a literal
call and a comparison; there is no process, no fixture and no capture involved,
which is what makes the absence worth closing rather than deferring.

The exposure is small but real: the stand-in strings are the *only* thing a
user sees for these inputs, and nothing would notice if an edit dropped a case
into the switch's implicit fall-through. `userInputToContent`'s `switch` has no
`default`, so an unhandled variant silently contributes nothing to the content
array rather than degrading visibly.

Do **not** capture fixtures for this. The types come from the vendored
bindings (`resources/codex-protocol/v2/UserInput.ts`, `.../ThreadItem.ts`), the
mapping is pure, and driving a real Codex session to emit a `skill` or a
`localAudio` input costs far more than the assertion is worth. This is the case
where hand-constructing the input is right, and it does not contradict OW-72's
"make a capture rather than guess": the shape is not being guessed, it is
being read off a generated type in the repo.

## Done when

- Each of the seven arms has an assertion on its mapped output, hand-built
  from the vendored type rather than from a capture.
- The assertions are on structure and the stand-in text these arms exist to
  produce -- this is one of the few places where the exact string *is* the
  behaviour, so `AGENTS.md`'s "never assert on model wording" does not apply;
  it is our wording, not the model's.
- Each watched red first, by breaking the arm it covers.
- `bun run check` passes.

Related: OW-32 records that these same arms are absent from DESIGN's mapping
table, and OW-vefiso that one further variant reaches no arm at all.

**Fixed** in d5793f9: seven cases in `reducer.test.ts`'s `item types with no
fixture yet` block -- `imageGeneration` and `imageView` alongside its existing
`mcpToolCall`/`webSearch` cases, and the five `UserInput` variants in a nested
`user input variants no fixture carries` describe. Inputs are hand-built and
pass through the block's `complete(item: ThreadItem)` helper, so the compiler
checks every field against the vendored bindings; nothing was captured. Each
arm was watched red by deleting it -- one test failing, the other 64 passing,
seven times -- and the exact stand-in text is pinned, confirmed by mutating
`[image: ` to `[img: ` with the arm intact and seeing only that one case go red.

Two things the vendored types corrected about the description above.
`imageGeneration` does not simply reference its `result`: `imageFromUrl` yields
an image block and `blockAsAssistant` then degrades it, because an assistant
turn carries no image block -- so a `data:` URL result renders as
`[image: image/png]`, only the mime type, while a path result keeps the path.
Both branches are asserted. And `skill` and `mention` each carry a `path`
beside `name` that the mapping deliberately drops, which the case names now
record so a later edit that starts emitting it reads as a change rather than a
fix.

Not filed, and noted here instead: `[image: image/png]` is a poor thing to show
a user after a successful image generation. It is deliberate, it is now pinned
as behaviour, and improving it is a rendering question rather than a mapping
one.
