---
labels: [defect]
---

# A Codex adapter disposed while its own failed start is killing the child resolves before the child has closed

Found 2026-09-30 by the adversarial read of OW-tozuyo, on `main` at ea4e835; it predates OW-tozuyo.
In service of `BackendAdapter.dispose`'s contract that it "resolves once the child is gone", which `CodexAdapter.finishDisposal` in `src/server/adapters/codex/adapter.ts` restates in its comment ("the last releaser awaits the kill and shutdown, which settles every adapter, waits for it").

## The sequence

1. `CodexAdapter.start` fails after spawning, for instance on a backend refusal of `thread/resume` or `initialize`.
2. Its catch block clears `this.holder` (`if (this.holder === holder) this.holder = null;`) and only then runs `await holder.release("codex adapter start failed")`, which is the last holder's release and so runs the shell's `kill()` — up to `TERMINATE_GRACE_MS` plus `KILL_GRACE_MS` in `src/server/adapters/child-process.ts`.
3. Shutdown lands inside that window: `SessionManager.disposeAll()` in `src/server/http/session-manager.ts` finds the startup in `#attaching` and terminates it. `pending.disposal` is not yet set, because `#start`'s own catch runs only after `adapter.start` rejects, which waits on the kill. So it calls `adapter.dispose()`.
4. `finishDisposal` reads `this.holder` as null, so `await holder?.release()` does nothing and `dispose()` resolves at once.
5. `disposeAll()` resolves, `src/server/index.ts` calls `process.exit(0)`, and the kill escalation never finishes. Its timers are `unref`'d.

What is load-bearing is that `dispose()` returns before the child it is killing has closed.
The visible cost is the OW-tozuyo stderr report of a child that outlives SIGKILL: it is lost on this path, since it is written at the end of the escalation.
The sbox wrapper's `--die-with-parent` means the sandbox is SIGKILLed when the server exits anyway, so what is lost is the report and the ordering guarantee, not a known leak.
Pi and Claude do not have this gap: neither kills inside `start()`.

## Done when

A test in `src/server/adapters/codex/` drives a start that fails after spawn with a child that ignores both signals, calls `dispose()` while the failing start's release is still in its grace period, and asserts that `dispose()` has not resolved until the escalation finishes (fake timers, as the existing "escalates a stuck termination and remains bounded" test in `codex/process.test.ts` does).
It must go red on `main` before the change and green after.
