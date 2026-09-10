---
labels: [defect, now]
---

# A server-side failure reaches nobody: nothing under `src/server/http/` logs, `ServerShuttingDownError` maps to a 500, and a bad `cwd` is accepted and fails later

Three symptoms of one gap, that the server has no channel for its own faults.

`src/server/http/app.ts`, the catch that returns `error(500, "internal_error", describe(err))`: that JSON body is the only trace of any throw.
There is no `console.*` call anywhere under `src/server/http/`.
A spawn that fails because `direnv` is absent, `sbox` refuses, or the session "has no recorded workspace" (`session-manager.ts`, `#start`) is invisible in the terminal running the server.
D13's reasoning already has this pattern's name: "a log line on a headless server is indistinguishable from swallowing it", and OW-15 records the same for one adapter probe.
The decision here is smaller than D13's `notice` arm: a server that prints its 500s to stderr, with the ref and the message, is the floor; whether they also reach the browser as a `notice` is D13's to take when OW-66 lands.

`session-manager.ts` defines `ServerShuttingDownError` and throws it from `attach` during shutdown; `app.ts` maps only `UnknownSessionError` and `UnknownBackendError`, so a mid-shutdown attach answers `500 internal_error`.
Map it to 503, or delete the class if nothing wants the distinction.
`session-manager.test.ts` stops at the class; nothing drives it through HTTP.

`app.ts`, `createSession`: the check is `typeof cwd !== "string" || cwd.length === 0` under an error message that promises "an absolute path".
A relative or nonexistent path becomes a `virtual` session and fails at first prompt inside `direnv exec <cwd>` resolved against the server's own cwd, surfacing only as the unlogged 500 above.
Check `isAbsolute` and existence at create time, where the 400 can name the problem.

## Done when

- A test in `app.test.ts` drives an adapter whose `start()` throws and asserts the failure was written to the injected log sink, whatever shape the implementer gives it; it fails before the change.
- A test asserts an attach during shutdown answers 503 and not 500.
- A test asserts `POST /api/sessions` with a relative `cwd` answers 400.

Added an injectable HTTP error log sink with a stderr default, including the session ref for session-route failures; mapped shutdown-time attaches to 503; and rejected relative, missing, or non-directory workspaces during session creation. Red-first HTTP tests observed the previous 201, unlogged start failure, and 500 shutdown response before the implementation. `bun run check` passed with 48 test files and 958 tests. Landed in 1eb66d4.
