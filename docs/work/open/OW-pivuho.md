---
labels: [defect]
---

# Codex's arrival decline may leave an unhandled rejection when a request line arrives after the process is killed

Filed 2026-09-24 while landing OW-yosuzo, whose implementer found the Pi form of this and fixed it there.

OW-zisumi's arrival decline, in the `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts`, calls `void this.reply(key, null)`.
If `reply` reaches `CodexProcess.write` in `src/server/adapters/codex/process.ts`, that throws "Codex process is not running" once the process is killed or closed, and `void` leaves the rejection unhandled.
A request line can still reach the reducer after the kill, because stdout goes on delivering what the process wrote before it saw the signal.
That is exactly what happened with Pi: with a bare `void`, the OW-yosuzo test "does not fail on a dialog that arrives after dispose, when the cancel has no pipe to go to" in `src/server/adapters/pi/process.test.ts` failed the vitest run on an unhandled rejection "Pi process is not running".
The Pi adapter now calls `this.reply(requestId, null).catch(() => {})`, and its comment in `handleLine` in `src/server/adapters/pi/process.ts` explains why.
Nobody has yet checked whether Codex's `reply` gets that far after a kill; read it before changing anything.

What matters here is that no rejection goes unhandled from the arrival decline, while the process's end stays reported as it is today.
It does not matter whether the fix is a `.catch` or a guard in `reply`.

## Done when

- A test in `src/server/adapters/codex/adapter.test.ts`, modelled on the Pi test named above, delivers a request line after `dispose()` and passes; it fails the run before the fix, or else the card closes with the reason `reply` cannot throw there.
- `bun run check` passes.
