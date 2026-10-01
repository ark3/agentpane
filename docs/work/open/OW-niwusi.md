---
labels: [defect]
---

# The live probes still follow a session by ref and wait on the retired renamed event, so the steer probe hangs and a second move escapes the smoke probe

OW-mofuho (`e8c9253`, 2026-09-25) retired the `renamed` SSE event from both wires: a rename is now said only by a `snapshot` under the session's `handle`, which a rename never changes (D24; the `handle` docblocks in `src/shared/protocol.ts`, `SessionSummary.handle` and the event-arm comment beginning "Every arm but `sessions-changed` carries `handle` beside `session`").
The live probes in `resources/probes/` were not moved with it, because none of them run in `bun run check`.

- `agentpane_pi_steer_probe.py` waits for `renamed` before its first turn (the `renamed` closure beside "D9: the id is the JSONL path and is adopted once Pi names the file", then `stream.wait_for(renamed, 60, "Pi to adopt its own session id (D9)")`), so every run now times out there, as `agentpane_pi_smoke.py` did until OW-yehisa.
  OW-nufitu's vehicle is this probe, so OW-nufitu is blocked on this card.
- `fork_attach_probe.py`'s `follow_renames` scans for `renamed` events and now never matches; the probe takes its ref from the attach reply, so it does not hang, but `turn`'s `settled` would miss a session that moved after attach.
- `agentpane_pi_smoke.py` was moved by OW-yehisa only as far as detecting the rename: its `renamed` closure takes the attach reply's `handle` and waits for the first `snapshot` under it naming a non-virtual ref, but every check after that (`text_stream`, `idle`, `resolved_model`, the abort phase) still filters events by `session == real_ref`.
  Two cases follow, both older than OW-yehisa: a rename that happens at the first prompt rather than at attach makes the probe wait 60s for a snapshot that only the prompt it has not yet posted would cause, so `renamed_during: "first prompt"` can never be recorded on a passing run despite the comment above the closure ("Both orderings are legitimate"); and a second move, which `SessionManager`'s docblock beside `#rename` in `src/server/http/session-manager.ts` says Pi can make ("Pi can move it again on the first prompt"), would leave every later wait filtering on a stale ref until it times out.

What this card is in service of: the probes identify a session the way the product does since D24, by handle, so that a move is something they record rather than something that hangs them.
The load-bearing part is keying the waits by handle; whether the probes share a helper for it in `agentpane_live_support.py` is incidental.
`agentpane_live_support.py`'s `SseReader` already buffers the whole stream and `wait_for` rescans it from the start, which is why a snapshot that lands before the attach reply is still found (confirmed by OW-yehisa's review).

## Done when

No probe under `resources/probes/` matches on `"renamed"` (`rg -n '"renamed"' resources/probes` prints nothing), and each of the three probes above keys its per-session waits by the handle the create or attach reply carried.
A run of `agentpane_pi_steer_probe.py` and one of `agentpane_pi_smoke.py` on the home server complete with `"result": "pass"` on the pinned model, recorded in `docs/MANUAL_TESTING.md` with the `pi` version, and `resources/probes/README.md`'s "Verified with" lines for both name those runs.
`fork_attach_probe.py` needs at least `python3 -m py_compile`; whether it gets a live run too is the executor's call, recorded in the same section.
