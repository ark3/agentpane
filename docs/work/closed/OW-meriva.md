---
labels: [change]
closed: done
---

# The Pi type packages are pinned at 0.84.1 while the installed pi 1.2.0 sends message shapes those types cannot describe

Filed 2026-10-14, when the home server's `pi --version` reported `1.2.0`.

`package.json` pins `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` at `0.84.1`, taken types-only under D10 in `docs/DESIGN.md` and enforced by `src/import-boundaries.test.ts`.
The installed Pi ships both at `1.2.0`, under `~/.bun/install/global/node_modules/@earendil-works/`.
Diffing the two `pi-ai/dist/types.d.ts` on 2026-10-14 found, among others: `Message` gains a `SystemMessage` arm (`role: "system"`, with `sections`, `toolsAdded`, `toolsRemoved`); `AssistantMessage` gains `thinkingLevel?`, `providerThinkingLevel?`, `endTurn?` and `durationMs?`; `ToolCall` gains `namespace?` and its `arguments` becomes `JsonObject`; `ToolResultMessage` becomes a conditional type whose `details` is `JsonRepresentation<T>`, loses `addedToolNames` and gains `nestedCalls?` and `durationMs?`.
The `role: "system"` and `thinkingLevel` shapes are not hypothetical: both are in the home server's own Pi session files as of 2026-10-14.

In service of D6's `AgentMessage` being the internal contract: while the pin lags, the contract describes a Pi that no longer exists, and code reasons about messages the type says cannot arrive.

## What is load-bearing

This card moves the pin and adapts what the new types break, and nothing more.
A behaviour change the new types make visible belongs to the card that owns it, not here: the `role: "system"` arm becoming part of the union is OW-wavini's, and `thinkingLevel` on assistant messages is OW-zarine's; this card may need a cast or a narrowing to keep today's behaviour and says so where it adds one.
Both pins move together and land on one version, the one the installed `pi` depends on.

## Done when

`package.json` and `bun.lock` pin both packages at the version the installed `pi-coding-agent` depends on, `src/import-boundaries.test.ts` still passes, and `bun run check` passes.
Every source change the bump forced is named in the commit message with the type change that forced it.
Any such change that alters what a user sees is not made here; a card is filed for it instead.

## Close note

Both `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` are pinned at `1.2.0` in `package.json` and `bun.lock`, the version the installed `pi 1.2.0`'s `pi-coding-agent` depends on (`^1.2.0`), checked 2026-10-14. The commit message lists every source change the bump forced and the type change behind each one. Verified by `bun run check` on `main` after landing: svelte-check found 0 errors, and 56 test files with 1633 tests passed, `src/import-boundaries.test.ts` among them. Before the source changes, the bump produced 40 type errors.

What the bump forced:
- `pi-agent-core 1.2.0` dropped its `harness/messages`, and with it the merge of `bashExecution`, `custom`, `branchSummary` and `compactionSummary` into `CustomAgentMessages`. That merge now lives only in `pi-coding-agent`, so `AgentMessage` had shrunk to `Message`. `src/shared/pi-messages.ts` copies the four shapes from `pi-coding-agent 1.2.0`. The only shape difference from 0.84.1 is that `BranchSummaryMessage.fromId` is now `string | null`. `docs/DESIGN.md` D10 records this file as the one exception to its no-vendoring rule, and says that a future pin move must re-diff the file by hand.
- `ToolCall.arguments` became `JsonObject` and `ToolResultMessage.details` became JSON-only. This forced field-level casts in the Codex mapping (because ts-rs `?:` members admit `undefined`), and casts in the Claude mapping and reducer for values parsed off the wire. Each cast's comment says why it is sound.

No change visible to users.
An adversarial reader found no correctness defect; its findings went into the commit (narrowed casts, a corrected justification, the D10 note, and the stale `args.ts` comment).
The `AssistantTurn` docblock in `src/shared/protocol.ts` is now stale, but that file is FROZEN under D11, so it went to OW-zarine as an amendment instead.

Noticed and not done: Pi 1.2.0 can send `ToolCall.namespace` (an OpenAI Responses namespace), `ToolResultMessage.nestedCalls`, and `durationMs`/`endTurn` on assistant messages, and nothing reads any of them. Pi tool calls render the bare `name`, whereas Codex renders `namespace__name`.
