---
labels: [defect]
---

# detachSession's docblock in App.svelte says a detach always stays on the transcript

Found 2026-09-23 by the implementer of OW-wedupe, from the code.

`detachSession` in `src/client/App.svelte` carries the one-line docblock "End the selected conversation's subprocess and stay on its transcript, now read-only (OW-tewave)."
That was already untrue before OW-wedupe: `detach()` in `src/client/controller.ts` lands a session with nothing on disk on the startup view (selection cleared, no preview), not on its transcript.
Since OW-wedupe that exit is chosen by `SessionSummary.onDisk` and covers every session created or forked here and detached before its first turn, so the docblock is wrong for the commonest early detach.

The docblock is in service of a reader deciding what the Detach control does; the load-bearing fact is the two exits in `detach()`, which the comment block above its `if (!listed?.onDisk)` branch states.

## Done when

The docblock names both outcomes -- the read-only preview for a session with a transcript on disk, the startup view otherwise -- or points at `detach()` for them, and `bun run check` passes.
