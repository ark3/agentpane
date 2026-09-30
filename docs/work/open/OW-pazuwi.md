---
labels: [deferral]
---

# A command written before a stdin EPIPE waits until close, which never comes if the child keeps running

Found by OW-sozopu's adversarial read, confirmed by running, not fixed there because it is shared by all three backends and was not a regression.

As of b3e0cad, `ChildProcessShell` in `src/server/adapters/child-process.ts` records a stdin `error` (EPIPE) in `stdinError` and reports it only when the child's `close` fires.
EPIPE marks stdin destroyed, so later writes throw "... process is not running" at once, but a command already written — a `sendCommand` in `PiAdapter` (`pi/process.ts`), a `CodexClient.request` (`codex/jsonrpc.ts`), a Claude turn — waits for `close`.
When the child really died, `close` follows once stdio drains, so this is fine.
When the child closed its own stdin and kept running (the repro OW-sozopu used to measure the EPIPE crash: a python child doing `os.close(0)` then sleeping), `close` never comes until it exits, and the pending command waits indefinitely with nothing reported.

No backend is known to close its stdin while staying alive, which is why this is a deferral.
If one is ever seen doing it, the load-bearing question is whether a stdin EPIPE should itself be treated as the child's death — kill it and report — rather than waiting on `close`.

Done when a test in `src/server/adapters/child-process.test.ts` emits `error` on the fake child's stdin with no `close` and asserts the shell reports a death within a bounded time (fake timers), red before the change; or the card closes `--declined` with that reasoning recorded.
