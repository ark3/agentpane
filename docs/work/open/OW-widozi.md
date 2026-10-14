---
labels: [defect]
---

# A Pi session forked at its first user message holds only its system message, which both clients' not-yet-prompted gates read as prompted

Found by OW-wavini's adversarial reader on 2026-10-14, read at the source and not run; it predates OW-wavini.

Since `pi 0.86.0` every Pi session file opens with a leading `role: "system"` message, and a fork at the first user message keeps it and nothing else: `docs/MANUAL_TESTING.md` records that under OW-dojebo ("Forking at the first user message kept the `model_change`, both `thinking_level_change` entries and the system message, and nothing else") and OW-riyeku, where `get_state` answered `messageCount` 1.
`hydrateMessages` in `src/server/adapters/pi/process.ts` takes `get_messages` whole, so that fork's transcript is `[system]`, not empty.
A fresh Pi session, by contrast, holds no messages until its first prompt (`docs/MANUAL_TESTING.md`, "Pi's system-role messages arrive live and from `get_messages` (OW-wavini)").

Both clients decide "not yet prompted" by an empty transcript, so they read that fork as prompted:

- The browser shows the model picker only `{#if selectedSession?.messages.length === 0}`, in the composer's `prompt-actions` row of `src/client/App.svelte`, so the fork offers no model choice before its first turn.
- The browser's `renamable` in `src/client/App.svelte` offers Rename only once a session has been prompted, by the same reading.
- In `emacs/agentpane.el`, `agentpane-set-model` is "Allowed only before the first prompt, while the buffer has no nodes", and the rename command beside it treats "a buffer whose ewoc holds no indexed node" as not yet prompted; since OW-wavini a system message projects to an indexed `"system"` node, as it projected to an unknown-role node before.
- `selectionIntent` handling in `src/client/controller.ts` (the `messages.length === 0` test near `selects(handle)`) may share the reading; check it.

In service of a fork that keeps no turn behaving as the unprompted session D23 in `docs/DESIGN.md` says it is ("A fork that keeps no turn ... runs at the parent's model and effort as they stand when it is cut").
Load-bearing: that a transcript of system messages alone is unprompted, in both clients alike (AGENTS.md, "Both clients").
Incidental: where the test lives, whether a shared predicate in `src/client/render/` that both `App.svelte` and the Emacs projection read replaces the scattered length checks, and whether Rename should in fact be offered there, which follows from whatever Pi's store does with a name on such a fork and is the executor's to check.

## Done when

A jsdom test in `src/client/` renders a Pi session whose messages are one system message (the `systemLeading()` sample in `src/client/render/samples.ts`) and asserts the model picker is offered, seen red first.
An ERT test in `emacs/agentpane-test.el` draws a buffer holding one `"system"` node and asserts `agentpane-set-model` is not refused as after the first prompt, seen red first.
Every gate listed above reads the same predicate or is shown in the close note not to need it, and `bun run check` passes.
