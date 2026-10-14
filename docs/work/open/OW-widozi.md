---
labels: [defect]
---

# A Pi session forked at its first user message holds only its system message, which both clients' not-yet-prompted gates read as prompted

Found by OW-wavini's adversarial reader on 2026-10-14, read at the source and not run; it predates OW-wavini.

Since `pi 0.86.0` every Pi session file opens with a leading `role: "system"` message, and a fork at the first user message keeps it and nothing else: `docs/MANUAL_TESTING.md` records that under OW-dojebo ("Forking at the first user message kept the `model_change`, both `thinking_level_change` entries and the system message, and nothing else") and OW-riyeku, where `get_state` answered `messageCount` 1.
`hydrateMessages` in `src/server/adapters/pi/process.ts` takes `get_messages` whole, so that fork's transcript is `[system]`, not empty.
A fresh Pi session, by contrast, holds no messages until its first prompt (`docs/MANUAL_TESTING.md`, "Pi's system-role messages arrive live and from `get_messages` (OW-wavini)").

Both clients decide "not yet prompted" by an empty transcript, so they read that fork as prompted.
Where a user meets it differs by client.
`agentpane-fork` in `emacs/agentpane.el` opens the fork in a buffer of its own, attached and unprompted, so an Emacs fork at the first message is exactly this state.
The browser's only fork is `forkAndSubmit` in `src/client/controller.ts`, which prompts the fork straight away, so the browser meets the state only when that prompt fails or when it selects a fork made elsewhere, such as from Emacs.

The model and effort gates, every one of which reads the empty transcript:

- `src/client/App.svelte`: the composer's `prompt-actions` row shows the model and effort pickers only inside `{#if selectedSession?.messages.length === 0}`.
- `src/client/controller.ts`: `loadModelsForSelected` returns early unless the transcript is empty, and tests it again near `selects(handle)` before publishing the models; `setModel` and `setEffort` each return without sending unless it is empty.
  Fixing the picker's `{#if}` alone would draw a picker with no models loaded, whose choice sends nothing.
- `emacs/agentpane.el`: `agentpane--check-gate`, which both `agentpane-set-model` and `agentpane-set-effort` call, refuses once the ewoc holds any indexed node; since OW-wavini a system message projects to an indexed `"system"` node, as it projected to an unknown-role node before.

The rename gates are not affected and are left alone: `renamable` in `src/client/App.svelte` and `agentpane--check-renamable` in `emacs/agentpane.el` test for an empty transcript only on a Codex session, and Codex writes no system message.

In service of a fork that keeps no turn behaving as the unprompted session D23 in `docs/DESIGN.md` says it is ("A fork that keeps no turn ... runs at the parent's model and effort as they stand when it is cut").
Load-bearing: that a transcript of system messages alone is unprompted, in both clients alike (AGENTS.md, "Both clients").
Incidental: where the tests live, and whether a shared predicate in `src/client/render/` that `App.svelte`, `controller.ts` and the Emacs projection read replaces the scattered length checks.

## Done when

A jsdom test in `src/client/` selects a Pi session whose messages are one system message (the `systemLeading()` sample in `src/client/render/samples.ts`), asserts the model picker is offered with the models loaded, chooses a model and an effort, and asserts both requests are sent; seen red first.
An ERT test in `emacs/agentpane-test.el` draws a buffer holding one `"system"` node and asserts `agentpane--check-gate` refuses neither the model nor the effort, seen red first.
Every model and effort gate listed above reads the same predicate, any further such gate the executor finds is named in the close note, and `bun run check` passes.
