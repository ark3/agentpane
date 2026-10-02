---
labels: [defect]
closed: done
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

## Amended 2026-10-01 by OW-geselo

Read at b758f98; the code above has moved, and the case it names cannot happen, but a sibling does.
`void this.reply(key, null)` is gone: the `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts` now calls `this.requireClient().respond(effect.requestId, DECLINE_RESPONSES[effect.kind])`, or `respondError(...)` for a kind with no decline shape.
Every step below it is synchronous -- `CodexClient.respond` → `send` in `jsonrpc.ts` → `ChildProcessShell.write` in `src/server/adapters/child-process.ts`, which throws "Codex process is not running" when `killed || closed || stdin.destroyed || stdin.writableEnded` -- so the failure is no longer an unhandled rejection but a synchronous throw out of the stdout `data` listener (`emitLine`), which nothing on that path catches.

**After `dispose()` it is unreachable.**
`finishDisposal()` sets `ownership = null` and calls `holder?.release()` before its first await; `CodexConnection.release` in `codex/connection.ts` splices the holder out of `#holders` at once, and `#deliver` routes a request only to an answerable holder from `#recipientFor`, so a late line finds no recipient.

**A child that dies on its own reaches it.**
A dispatched reader reproduced it on Bun 1.4.0 with a throwaway script: a real child closed its stdin, a large `write` took EPIPE and destroyed stdin, a request line still draining from stdout reached an answerable holder, and `holder.respond` threw "Codex process is not running" up through `#deliver` ← `emitLine` ← the stdout `emit`; the process exited 1, and `src/` has no `uncaughtException` handler.
Node and Bun both destroy `child.stdin` on `exit`, so a request delivered between `exit` and `close` would throw the same way without any EPIPE; three runs of a second script did not get the line to arrive after `exit`, which is a small sample, not a proof.
It needs the child to send a `ServerRequest`; under D7a's `approvalPolicy: "never"` none had been seen as of `codex-cli 0.154.0`.
Pi guards its equivalent write with `try { this.writeLine(...) } catch {}` in `handleLine` in `src/server/adapters/pi/process.ts`; Codex has no such guard.

## Done when (replaces the one above)

- A test in `src/server/adapters/codex/adapter.test.ts`, with a fake process whose `write` throws once it reports itself closed, delivers a request line and expects no throw out of the line handler, going red first.
- The process's own end is still reported as it is today.
- `bun run check` passes.

## Close note

Built: the `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts` now wraps both arrival replies — `respond` with a decline shape and `respondError` for a kind with none — in `try {} catch {}`, with a comment naming the case (the child died on its own while the request line was still draining from stdout; the exit path reports that end).
`requireClient()` stays outside the try, so its "not started" throw surfaces as before, and the error naming the declined kind still fires, as Pi's does.

Verified: the new test "does not throw out of the line handler when the child is gone while a request line still drains (OW-pivuho)" in `src/server/adapters/codex/adapter.test.ts` uses a `ClosedStdinProcess` fake whose `write` throws once `closed`, sends one request of each kind, then exits the process and asserts both kind-naming errors arrive before the exit error, with no response written.
It was red before the fix, and red again with each of the two guards removed alone; `bun run check` passed (56 files, 1615 tests).
An adversarial reader found no other path from Codex's stdout line handler that writes to the child, and no floating `request(...)` promise on it.

It also found that Claude's `refuseControlRequest` makes the same write unguarded; filed as OW-yofoli, which moves this to one owner and retires both this guard and Pi's.
