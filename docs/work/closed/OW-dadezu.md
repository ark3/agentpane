---
labels: [defect]
closed: done
---

# Two Pi probes read a notice event's text from the wrong field, so a rerun records every notify as None

Filed 2026-10-14 from OW-fusoba's adversarial read.

In service of the probes in `resources/probes/` still recording what reaches the wire now that Pi's `notify` is a notice (`docs/DESIGN.md` D11, "Pi's `notify` is a notice.").

`sse_rows` in `resources/probes/agentpane_pi_prompt_window_probe.py`, its `elif kind in ("error", "notice"):` branch, reads `event.get("message")` for both kinds.
An `error` event carries `message` at the top level, but a `notice` event carries it under `notice` — `notice()` in `src/server/http/broadcaster.ts` fans out `{ type: "notice", ...address, notice }`, with `notice` the `AgentNotice` of `src/shared/protocol.ts`.
Before OW-fusoba no Pi session produced a notice, so the branch never mattered for these probes; now each handled prompt's `notify` arrives as one, and a rerun records its row with `message: None`.

`resources/probes/agentpane_pi_fork_first_turn_probe.py` collects `error` and `notice` rows together under `fork_sse_errors`, so a notice — for instance one an extension's `session_start` sends at the fork — now reads there as an error.
Whether that key splits, or is renamed, is the executor's call.

## Done when

- Run against a recorded or hand-built SSE event list, `sse_rows` yields a notice row whose `message` is the notice's `message`, and an error row whose `message` is the error's — shown failing for the notice row before the fix.
- The fork probe's output no longer files a notice under a key named for errors.

## Close note

Fixed in aec222c, which touches only probes, so `bun run check` was not run.
`sse_rows` in `resources/probes/agentpane_pi_prompt_window_probe.py` now handles `error` and `notice` separately: an error row keeps the event's top-level `message`, and a notice row reads `kind` and `message` from the nested `event["notice"]` (the `AgentNotice` that `notice()` in `src/server/http/broadcaster.ts` fans out).
`resources/probes/agentpane_pi_fork_first_turn_probe.py` splits the old `after["fork_sse_errors"]` into `fork_sse_errors` (error rows only) and `fork_sse_notices`.
No doc named that key, and the OW-tigaye line in `docs/MANUAL_TESTING.md` ("no `error` or `notice` on the wire") still holds, because the old combined list counted notice rows even when their message was None.

Verified against a hand-built event list: one `error` event with `message: "boom"`, one `notice` event with `notice: {kind: "info", message: "hello from notify", details: None, path: None}` on the same handle, and a `notice` on another handle that must be dropped. Run with `python3 -I`, the probes dir on `sys.path`, and `sse_rows(events, 0, handle)`.
Before the fix: `[{'type': 'error', 'message': 'boom'}, {'type': 'notice', 'message': None}]`, so the notice check failed.
After: `[{'type': 'error', 'message': 'boom'}, {'type': 'notice', 'kind': 'info', 'message': 'hello from notify'}]`, and both checks passed.
An adversarial reader checked every `ServerEvent` arm in `src/shared/protocol.ts` against the fields `sse_rows` reads, and found no other nested-payload misread and no other probe reading notice fields off SSE.
Neither probe was rerun live against Pi.
