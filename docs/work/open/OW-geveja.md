---
labels: [deferral]
---

# Claude's `toolNames` is a per-turn map that nothing expires

A small leak, not observable at human session lengths.

Amended 2026-09-24: this card also carried a Pi half, `pendingUiRequests` never expiring a timed-out dialog.
OW-yosuzo made Pi cancel every dialog at arrival, which leaves that half unreachable until OW-bijera holds dialogs again, so it moved to OW-siguzo, which OW-bijera blocks.

`src/server/adapters/claude/reducer.ts`, `toolNames`: it maps a `tool_use` id to its name so the result can be labelled, and it is cleared only in `reset()`.
Every other per-turn map is cleared at `result`; this one grows by one entry per tool call for the life of the attached session.
Clear it at `result` like the others, or record why it must survive the turn.

## Done when

A test in `claude/reducer.test.ts` asserts `toolNames` is empty after `result`, and fails before the change.
