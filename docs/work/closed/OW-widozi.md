---
labels: [defect]
closed: done
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

## Close note

Built: `unprompted(messages)` in `src/client/render/system.ts` (true when every message is `role: "system"`, an empty transcript included; false for no view) is now the one predicate behind every browser model and effort gate: the composer's picker `{#if}` in `src/client/App.svelte`, both checks in `loadModelsForSelected`, `setModel` and `setEffort` in `src/client/controller.ts`.
`agentpane--check-gate` in `emacs/agentpane.el` applies the same rule in elisp, refusing only on an indexed node whose `:role` is not `"system"`; a dispatched reader traced `:role "system"` from `nodeFor` in `src/emacs/nodes.ts` through snapshot, live-node and preview paths into the ewoc.
No further model or effort gate keyed on an empty transcript was found in the browser, the controller, the Emacs client, the projection or the server; the Codex-only rename gates were left alone as the card asked.

Verified: the App.test.ts case "offers and sends a model and effort for a Pi session holding only its system message (OW-widozi)" drives the real controller on `[systemLeading()]` and failed with the fix reverted ("Unable to find a label with the text of: Conversation model"), and failed again with each of the four controller gates reverted one at a time; the ERT test `agentpane-test-gate-reads-system-nodes-alone-as-unprompted` failed with the fix reverted (`user-error "The model is chosen before the first prompt"`) and also asserts a system node plus a user node is refused.
Review added an `unprompted` table in `src/client/render/system.test.ts`, whose `[system, user]` case was seen red against a too-broad predicate.
`bun run check` (1651 tests) and the ERT suite (252, 0 unexpected) pass.

Left alone: the server's Pi fork still re-sends the parent's model and level only on `messageCount` 0, so a `[system]`-only fork restores the branch's opening settings; that is OW-bupuko, already open.
A browser edit-fork at a Pi first message now shows the picker during the window between attach and the prompt's user message arriving, as Claude Code and Codex forks always did; neither client's gate reads `sending` or streaming, before or after this change.
