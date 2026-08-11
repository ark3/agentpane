# Task 2 report: typed REST and SSE client

## Implementation

- Added `src/client/api.ts` with `AgentpaneApi`, `ApiClientError`, `EventConnection`, `ApiOptions`, and `EventHandlers`.
- Implemented typed REST methods for listing, creating, attaching, prompting, and aborting sessions using shared `ROUTES` and protocol envelopes.
- Added 2xx handling, JSON API error decoding, HTTP-status preservation for non-JSON errors, and JSON headers only for body-bearing requests.
- Added a default SSE adapter that constructs `EventSource` only when `connect()` is called, parses server events, maps open/error callbacks, reports malformed JSON, and closes the native source.
- Added `src/client/api.test.ts` covering request construction/decoding, errors, injected fetch/open-events dependencies, SSE lifecycle callbacks, malformed payloads, and close delegation.

## TDD and verification evidence

1. RED: `bunx vitest run --project client src/client/api.test.ts` failed during collection because `./api.ts` did not exist (`Failed to resolve import "./api.ts"`).
2. GREEN focused run: `bunx vitest run --project client src/client/api.test.ts` passed, 10 tests.
3. Type verification: `bun run typecheck` passed; `tsc --noEmit` and `svelte-check` reported 0 errors and 0 warnings.
4. Full verification: `bun run check` passed; 27 test files and 400 tests passed, with 0 typecheck/svelte-check diagnostics.

## Self-review

- Module import does not instantiate `EventSource` or make a fetch request; both browser boundaries are deferred/injectable.
- All requested routes and response envelopes are exercised by focused tests, including encoded session IDs and optional cwd encoding.
- Error objects preserve status and expose protocol `code`/`detail` when present.
- No unrelated files or server behavior were changed.

## Concerns

- Successful response envelopes are trusted via the frozen protocol types rather than runtime schema validation; malformed successful JSON would surface as a normal decoding error.
- The default SSE adapter reports every native `error` callback as a disconnect and intentionally does not add reconnect/backoff policy, which is outside this task's boundary.
