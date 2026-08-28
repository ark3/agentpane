---
labels: [deferral]
---

# Reset leaves `tokenUsage`, `threadId`, `turnId` and `unmappedItemTypes` in place.

Codex reducer

Whether those should survive a reset is unsettled.

**Closed on 2026-08-19: moot, and the call chain is why.** Verified at the
source, because the answer is not visible from `reset()` alone:

- `reset()` has one caller, `hydrate()` (`codex/reducer.ts:143`).
- `hydrate()` has one caller, `codex/adapter.ts:217`, inside `start()` and
  guarded by `opts.resumeId && started.thread.turns?.length`.
- `start()` refuses a second run: `if (this.client) throw new Error("codex
  adapter already started")` (`:154`).
- The reducer is built in the adapter's constructor (`:138`), and D12 eviction
  disposes the adapter, so re-attaching constructs a new one.

So `reset()` only ever runs on a reducer that has processed nothing. All four
fields are at their initial values -- `null`, `null`, `null`, empty set -- at
the only moment the question can be asked, and `hydrate` then overwrites
`threadId` on the next line and `turnId` per turn. The `turns.length` guard
makes the empty-turns case that would strand `turnId` unreachable. There is no
state to preserve or clear, so there is no semantics to choose; `reset()`
clearing only the transcript is fine as defensive code.

What the question was circling is now **OW-kelomi**: `tokenUsage` is assigned
at `:358` and read by nothing in `src/`, while the Codex compaction marker
ships `tokensBefore: 0` for want of that very payload. `unmappedItemTypes` is
in the same unread condition but its docblock says diagnostics-only, so it
reads as intended rather than as a gap.
