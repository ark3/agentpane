---
labels: [defect]
closed: done
---

# A fork Pi refuses reaches agentpane's fork route as 500 internal_error instead of 400 backend_refused

Filed 2026-10-14 from OW-tigaye's live run on the home server, `pi 1.2.0`, pinned `openrouter/deepseek/deepseek-v4.1-flash:high`; see `docs/MANUAL_TESTING.md`, "A Pi session's file appears at its first user message, and a fork at that message has none when `fork` returns (OW-tigaye)", subsection "A fork before the first assistant reply".

## What happens

`POST /api/sessions/pi/<file>/fork` with `{"entryId": "no-such-entry"}`, sent to a Pi session before its first prompt, answered 500 with body `{"error": "internal_error", "detail": "Invalid entry ID for forking"}` in both recorded runs, and the server logged `session pi:<file>: Invalid entry ID for forking` as an internal error.
The session was unharmed: still attached, idle, no SSE event, and a re-attach answered 200.
The Emacs helper's `sessions/fork` passes the route's status through as the JSON-RPC error code (`toRpcError` in `src/emacs/helper.ts`), so it answers code 500 too; read at the code, not run.

The chain, read at the code:
- `PiAdapter.fork` in `src/server/adapters/pi/process.ts` sends `fork` through `sendCommand`, and Pi's `success: false` response becomes a `PiCommandError` (`handleResponse`), which `fork` lets propagate unchanged.
- The `fetch` catch in `createApp` in `src/server/http/app.ts` maps only `BackendRefusedError` to 400 `backend_refused`; everything else falls through to 500 `internal_error`.
- `PiAdapter.setModel` in the same file already converts a `PiCommandError` into a `BackendRefusedError`, which is the precedent; `ClaudeAdapter` does the same for `ClaudeControlError` in `src/server/adapters/claude/adapter.ts`.

Any fork Pi refuses takes this path, not only the bad id measured: on `pi 1.2.0` RPC `fork` also answers `Invalid entry ID for forking` for a non-user entry, and the "This session has not been saved yet" refusal is reachable through `clone`, which agentpane does not send.
Neither client sends a bad id, since both list `fork-points` first, so the reach is a raw HTTP or JSON-RPC caller, and a 500 tells that caller the server broke when the request was what was wrong.

In service of the route's status meaning what it says: a refusal by the backend is the caller's 400, and a 500 is reserved for agentpane's own faults.
OW-wibude is the same 500 on Pi's prompt route, but its fix retires the refusal rather than remapping it, so it does not cover this.
Whether Claude Code's and Codex's `fork` map a refused entry the same way is for the executor to read at the source; a case that is already a 400 there needs nothing.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, shown red first, asserts that a `fork` whose Pi response is `success: false` rejects with a `BackendRefusedError` carrying Pi's message.
- The fork route answers a refused Pi fork with 400 `backend_refused`, asserted in the route's test (`src/server/http/app.test.ts` or wherever the fork route's tests live).
- `bun run check` passes.

## Close note

`PiAdapter.fork` in `src/server/adapters/pi/process.ts` now turns a `PiCommandError` from the `fork` command alone into a `BackendRefusedError` carrying Pi's message, following `setModel`; `get_state` and the re-sends after Pi has forked are unchanged, so a dead process, disposal or write failure still rejects with a plain `Error` and stays 500. The fork route therefore answers a refused Pi fork 400 `backend_refused`, and the Emacs helper's `sessions/fork` answers code 400.

It is a `try`/`catch` around the `await`, not `.catch()`: three fork tests in `process.test.ts` step exactly one microtask between answering `fork` and `get_state`, and `.catch()` adds one, which hangs them (confirmed by the adversarial read).

Verified: the new adapter test "refuses a fork Pi refuses, with Pi's reason (OW-rasiwa)" fails on the unfixed `process.ts` ("expected Error: Invalid entry ID for forking to be an instance of BackendRefusedError") and passes with the fix. The route test in `app.test.ts` ("answers 400 with the backend's reason when it refuses the fork") uses the fake adapter's new `onFork` hook in `src/server/http/testing/fakes.ts` and covers only the route's existing mapping, so it could not go red on the unfixed adapter; it was shown red by disabling that mapping in `createApp`. `bun run check` passed on `main`, 1671 tests. Not re-run live.

Known imprecision, shared with `setModel`: in `pi 1.2.0` source (`rpc-mode.js`, `handleInputLine`) any exception from a command handler becomes `success: false`, including throws inside `AgentSessionRuntime.fork` after the old session is torn down; such a Pi fault would now read as 400 and not be logged. Never observed.

`docs/MANUAL_TESTING.md`'s code-read sentences under "Through agentpane, the fork route answered 500 for Pi's `Invalid entry ID for forking`" were retired to past tense in the same landing. Claude Code and Codex still answer an unknown fork point 500; filed as OW-fesuwe.
