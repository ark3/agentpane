---
labels: [defect]
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
