---
labels: [defect, now]
---

# Closing a session and re-attaching it before dispose settles spawns a second agent on the same session file

`src/server/http/session-manager.ts`, `close()`: after the pending-startup branch, `this.#sessions.delete(key)` runs, aliases and pending requests are cleared, and only then is `session.adapter?.dispose()` awaited.
Dispose is not instant: it is SIGTERM, a bounded wait, SIGKILL, another wait, and the comment near the grace constants says Codex can use the whole grace.
An `attach` for the same ref arriving in that window finds nothing in `#sessions` and nothing in `#attaching`, goes through `#start`, and spawns a second subprocess on the same on-disk session while the first is still dying.
`#attaching` tracks startup so that a close can find a session that has no table entry yet; nothing tracks disposal the same way, so an attach cannot find a session that has just left the table.

No test covers close followed immediately by attach; the "teardown racing a startup" cases in `session-manager.test.ts` cover the other direction.

The shape of the fix is the mirror of `#attaching`: a per-key disposal promise that `attach` awaits, or joins and then proceeds, before it consults the table.
D12's reaper (OW-33) will evict through the same path and inherits whichever answer this card records, so name it in the docblock.

## Done when

- A test in `session-manager.test.ts` closes a session whose fake adapter's `dispose()` is held open, attaches the same ref while it is held, releases it, and asserts exactly one spawn happened after the first; it fails before the change.
