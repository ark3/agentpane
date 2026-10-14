---
labels: [change]
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
