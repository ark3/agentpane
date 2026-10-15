---
labels: [defect]
---

# A fork at an entry Claude Code or Codex cannot fork from reaches the fork route as 500 internal_error instead of 400

Filed 2026-10-15 from OW-rasiwa, which fixed the same 500 for Pi; read at the code on `main` after that landed, not run.

## What happens

`POST /api/sessions/<backend>/<id>/fork` with an `entryId` the session has no fork point for answers 500 `internal_error` on Claude Code and on Codex, where on Pi it now answers 400 `backend_refused` (OW-rasiwa).
The Emacs helper's `sessions/fork` passes the route's status through as the JSON-RPC error code (`toRpcError` in `src/emacs/helper.ts`), so it answers 500 too.

The chain, read at the code:
- `ClaudeAdapter.fork` in `src/server/adapters/claude/adapter.ts` calls `readForkHistory`, which throws a plain `Error` with the message "unknown fork point: <id>" when no store entry carries that uuid.
- `CodexAdapter.fork` in `src/server/adapters/codex/adapter.ts` throws the same plain `Error` when the id is not in `turnOrder`.
- If Codex's own `thread/fork` request is refused, it rejects with `CodexRpcError` (`src/server/adapters/codex/jsonrpc.ts`); as of `codex-cli 0.156.0` an unknown turn was refused with `-32600 turn not found` (`docs/MANUAL_TESTING.md`, OW-hojefo), though the `turnOrder` check above normally stops a bad id first.
- The `fetch` catch in `createApp` in `src/server/http/app.ts` maps only `BackendRefusedError` to 400; everything else is 500.
- `SessionManager.fork` in `src/server/http/session-manager.ts` passes the adapter's error through unchanged and holds no state before the adapter succeeds, so nothing needs undoing on a refusal.

Neither client sends a bad id, since both list `fork-points` first, so the reach is a raw HTTP or JSON-RPC caller, and a 500 tells that caller the server broke when the request was what was wrong.

In service of the fork route's status meaning what it says on every backend: a request naming an entry that cannot be forked from is the caller's 400, and a 500 is reserved for agentpane's own faults.
The load-bearing part is the unknown-fork-point case on both adapters.
Whether a `CodexRpcError` from `thread/fork` should also become a `BackendRefusedError` is the executor's call: some of those errors are refusals and some may not be, and `CodexAdapter`'s other conversions, if any, are the precedent to read.
`PiAdapter.fork` and `PiAdapter.setModel` in `src/server/adapters/pi/process.ts`, and `ClaudeAdapter.setModel`, show how a refusal becomes a `BackendRefusedError` here; `BackendRefusedError`'s docblock in `src/server/adapters/types.ts` lists its throwers and should name these too.

## Done when

- A test in `src/server/adapters/claude/adapter.test.ts`, shown red first, asserts that a fork at an unknown entry rejects with a `BackendRefusedError`; the existing "rejects an unknown fork point without touching the child" asserts only the message and may be the one to tighten.
- A test in `src/server/adapters/codex/adapter.test.ts`, shown red first, asserts the same for `CodexAdapter.fork`.
- `bun run check` passes.
