---
labels: [deferral]
---

# `setModel` changes outgoing turns, but the reducer's identity may still report the previous model.

Codex adapter

OW-derewo reports the picker model from the adapter-owned value after a successful `setModel`, so reducer identity lag until the next turn cannot make the picker stale.

## Amended 2026-10-01 by OW-geselo

Read at b758f98: still true, wider than the headline says, and Codex's alone.
`setModel` in `src/server/adapters/codex/adapter.ts` sets `this.model` and emits `status`, and never calls `reducer.setIdentity`; the reducer's `identity.model` is set only at start, resume and fork.
The lag is not "until the next turn": `remap` in `codex/reducer.ts` builds its mapping context from `...this.identity`, and `mapping.ts` stamps `model: ctx.model` on every assistant message, so every message mapped after a switch carries the old model until the adapter restarts.
`submit` already refreshes the reducer's effort before each turn (`if (this.effort) this.reducer.setIdentity({ reasoningEffort: this.effort })`) and not its model.

What shows it: the browser's per-turn footer in `src/client/render/Message.svelte` (`{#if turn.model}`), and the Emacs meta line through `metaFor` in `src/emacs/nodes.ts`.
What does not: status events, the picker and the Emacs mode line, which read the adapter-owned `getState().model` (OW-derewo); Claude stamps each message from the API's own `message.model`, and Pi's messages come from Pi.

## Done when

A test in `src/server/adapters/codex/adapter.test.ts`, beside "applies a selected model to subsequent turns", calls `setModel`, submits, feeds an `agentMessage` item, and asserts the assistant message in `getState().messages` carries the selected model; it goes red first, carrying the start model.
`bun run check` passes.
