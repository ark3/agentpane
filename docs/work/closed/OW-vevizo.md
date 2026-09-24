---
labels: [change]
closed: done
---

# Codex 0.156.0 added a functionCallOutput thread item that the mapper flags as an unknown type

Found 2026-09-24 while executing OW-riluye, which regenerated `resources/codex-protocol/` from `codex-cli 0.156.0`.
`resources/codex-protocol/v2/ThreadItem.ts` now carries a variant `{ "type": "functionCallOutput", id, name, namespace, output: FunctionCallOutputBody }` that the bindings vendored on 2026-08-10 did not.
`src/server/adapters/codex/mapping.ts` has no case for it, so it reaches the switch's `default` arm ("unknown item type: ${type}") and comes back with `unknownType: true`; the docblock on that field, near "`unknownType` is the load-bearing half", says what that flag sets off downstream.
The type check does not catch this, because the `default` arm accepts any variant.

Nobody had seen one of these items arrive when this was filed.
Decided by the owner on 2026-09-24: draw it as a tool result, the way `mcpToolCall` and `dynamicToolCall` draw theirs in the same file, rather than list it in `SILENT_ITEM_TYPES`.
The item carries output a reader may want, and the owner's standing preference, set when OW-fomebu chose to surface Codex warnings, is to show what Codex sends rather than swallow it.

Unlike those two, the item carries no arguments and no status, only `name`, `namespace` and an `output` that is a string or a list of `FunctionCallOutputContentItem` (text, image, audio, or `encrypted_content`).
Load-bearing: the item renders as a tool result named the way `dynamicToolCall` names its tool, carrying its text and images, and no longer comes back `unknownType`.
Incidental: what stands in for the missing arguments and status, and how audio or encrypted content is shown.
Both clients draw tool results from the same projection (`src/emacs/nodes.ts` reuses `$client/render/`), so this needs no Emacs work of its own.

Try to elicit one live, driving Codex with `codex -m gpt-5.6-luna` per AGENTS.md "Evidence", and record in `docs/MANUAL_TESTING.md`, with the version, whether and when it arrived.
If no run produces one, the test is built from the generated type and the record says the item was not seen.

Done when `mapping.ts` has a `functionCallOutput` case that renders it as a tool result, with the codex-cli version beside it, and a test in `src/server/adapters/codex/reducer.test.ts` shows it red without that case and green with it; the live attempt is recorded; and `bun run check` passes.

## Close note

`mapItem` in `src/server/adapters/codex/mapping.ts` now has a `functionCallOutput` case that draws the item as a tool pair named `namespace__name` or `name`, like `dynamicToolCall`. The call carries empty arguments, the result is never an error, text and `data:` images carry through, and a `file_id` image, audio and encrypted content show as plain bracketed references.
Three tests in `src/server/adapters/codex/reducer.test.ts` ("functionCallOutput (OW-vevizo)") were red without the case, with `unmappedItemTypes` holding the type or no tool result at all, and green with it; `bun run check` passed.
Elicited live on `codex-cli 0.156.0` with `gpt-5.6-luna`: a `turn/start` carrying `toolOutput` and an empty `input` opens its turn with the item. That start is refused if `input` is nonempty. The two captured shapes are what the tests drive, recorded in `docs/MANUAL_TESTING.md`, "A Codex turn started with `toolOutput` opens with a `functionCallOutput` item".
Whether a model-made function call ever emits the item was not probed.
The rollout stores the item without a `call_id`, which the session preview drops; filed as OW-hejoza.
