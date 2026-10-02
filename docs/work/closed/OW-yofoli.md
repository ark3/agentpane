---
labels: [defect]
closed: done
---

# A reply written from a line handler after the child dies throws out of stdout; one owner should drop it, not a guard per adapter

Filed 2026-10-01 from the adversarial read of OW-pivuho, which guarded Codex's arrival decline at its call site.

Every adapter refuses an agent request the moment its line arrives (D2a), by writing a reply to the child from inside the stdout line handler.
That write goes to `ChildProcessShell.write` in `src/server/adapters/child-process.ts`, which throws "<name> process is not running" once `killed || closed || stdin.destroyed || stdin.writableEnded`.
A child that dies on its own can still have a request line draining from stdout after EPIPE (or `exit`) destroyed its stdin, so the throw escapes the stdout `data` listener as an uncaught exception, and `src/` has no `uncaughtException` handler: the server exits.
OW-sozopu measured that crash on Bun 1.4.0 with a real child.

Today two of the three adapters carry a guard at the site, and the third does not:

- Pi: `try { this.writeLine(...) } catch {}` in `handleLine` in `src/server/adapters/pi/process.ts`, from OW-yosuzo.
- Codex: `try { client.respond(...) } catch {}` and the same around `client.respondError(...)`, in the `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts`, from OW-pivuho.
- Claude: **unguarded.** `ClaudeAdapter.refuseControlRequest` in `src/server/adapters/claude/adapter.ts`, reached from `handleLine`, calls `proc.write(...)` bare in both branches (the `can_use_tool` deny and the generic error reply). Claude's process is a `ChildProcessShell` too (`src/server/adapters/claude/process.ts`), so the same drain-after-death line takes the server down.

A guard per call site is what let the third one be missed, and the next adapter or the next reply-from-a-handler would be missed the same way.
The state belongs to whatever knows the child is gone: a reply nobody can deliver to a dead child is not an error worth throwing, and the death itself is already reported by the shell's exit/close path.
Where that ownership lands — a non-throwing reply write on `ChildProcessShell`, a shared helper the three adapters call, or something else — is the implementer's call; what matters is that one place decides it and the per-site `try {} catch {}` guards go.
Keep `write` throwing for the callers that need it: `CodexClient.request` turns a `send` throw into a rejection its awaiter sees, and Pi's `sendCommand` relies on the same.

The error each adapter emits naming the declined kind should still fire; that is what OW-pivuho kept, matching Pi.

## Done when

- A test in `src/server/adapters/claude/adapter.test.ts`, with a fake process whose `write` throws once its stdin is gone, delivers a `control_request` line for `can_use_tool` and one for another subtype and expects no throw out of the line handler; it goes red first.
- The existing tests that guard the other two — "does not fail on a dialog that arrives after dispose, when the cancel has no pipe to go to" in `src/server/adapters/pi/process.test.ts` and "does not throw out of the line handler when the child is gone while a request line still drains (OW-pivuho)" in `src/server/adapters/codex/adapter.test.ts` — still pass.
- The per-site `try {} catch {}` around the reply writes in Pi's `handleLine` and Codex's `applyEffects` are gone, replaced by the one owner.
- Each process's own end is still reported as it is today.
- `bun run check` passes.

## Close note

Built: `ChildProcessShell.reply` in `src/server/adapters/child-process.ts` is the one owner. It writes while the child runs and drops the line once the child is going or gone, sharing a private `gone()` with `write`, which still throws for `CodexClient.request` and Pi's `sendCommand`. `ClaudeProcess` and `CodexProcess` expose `reply`; Claude's `refuseControlRequest` (both branches), `CodexClient.respond`/`respondError`, and Pi's dialog cancel in `handleLine` all go through it, and the per-site `try {} catch {}` guards in Pi's `handleLine` and Codex's `applyEffects` are gone (`rg "catch \{\}" src/server/adapters` is empty). The declined-kind errors still fire, and the exit/close reporting path is unchanged. Pi needs no disposed check of its own: `finishDisposal` calls `proc.kill()` before its first await, so a disposed adapter's shell already counts as gone.

Verified: the new Claude test "does not throw out of the line handler when the child is gone while a request line still drains (OW-yofoli)" in `src/server/adapters/claude/adapter.test.ts` went red against the unfixed adapter ("Error: Claude Code process is not running" thrown out of the handler), re-run by the dispatching session in a scratch checkout. A new shell test in `child-process.test.ts` shows the reply written while alive and dropped after stdin is destroyed and after close, with `write` still throwing. The existing Pi after-dispose and Codex OW-pivuho tests still pass, and went red when the implementer pointed the replies back at a throwing write. `bun run check` passed: 1631 tests.

The adversarial read found no other write that can run inside a line handler's synchronous extent in any of the three adapters, the Codex connection, or the session manager's subscribers. Residual risk, not filed: `reply` versus `write` is a convention the types do not enforce, so a future refusal site written with `write` would bring the crash back. Also, no adapter-level test drives the "died on its own" case (stdin destroyed, not killed) through a real shell; the shell test covers that condition directly.
