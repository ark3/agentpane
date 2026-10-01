---
labels: [change, sweep-0929]
blocked-by: [OW-yehisa]
---

# Codex items reach the transcript through two unconnected mappers, live mapItem and the preview's extractStoreTurn, and no fixture keeps the rollout of the run it captured, so nothing catches them disagreeing

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
This card unblocks rather than moots: eleven open cards are each one place the two mappers disagree, or are waiting on a capture that does not exist.

## Two owners of one shape

- An attached session, live or rehydrated through `thread/turns/list`, goes through `mapItem` in `src/server/adapters/codex/mapping.ts`.
- A preview reads the rollout Codex writes to disk through the hand-written `extractStoreTurn` in `src/server/sessions/codex.ts`.
Nothing ties them together, and each stored-side card is one disagreement: the `namespace__name` naming (OW-kelise), a record with no `call_id` dropped (OW-hejoza), a compaction marker's hardcoded empty `summary` (OW-wapage), `SYNTHETIC_USER_PREFIXES` lacking `<turn_aborted>` (the stored half of OW-yobuyi), non-`exec_command` scripts and the shell preamble (OW-zabiko), and a multi-file patch (OW-4, whose Emacs half goes through `diffFor` in `src/emacs/nodes.ts`).

## Why nothing catches it

`resources/probes/capture_fixtures.py` starts every Codex thread with `ephemeral: True` ("keeps the thread out of the on-disk rollout store entirely") and Pi with `--no-session`, so no fixture pairs a live stream with the rollout of the same run.
`src/server/sessions/preview.test.ts` says in its header that the preview tests use made-up store lines, giving as its reason that the recorded fixtures are RPC-stream captures of a different shape; that is already slightly false, since `resources/fixtures/codex/fork.jsonl` is a real 0.147.0 rollout no preview test reads.
The live-side cards are blocked on the same absence: OW-19 (`plan`), OW-kehose (image generation), OW-guyunu (failed and multi-child collab calls), OW-yobuyi's live half (interrupt), and the rows `docs/DESIGN.md`'s "Codex `ThreadItem` → `AgentMessage` mapping" section says "have no capture yet" (`plan`, `webSearch`, `mcpToolCall`, `dynamicToolCall`).
OW-wujuda and OW-pukado are the version-drift side of the same fixtures: as of this sweep `codex --version` reported `codex-cli 0.157.1`, against fixtures captured on 0.147.0.

## The change

1. Extend `capture_fixtures.py` with scenarios for plan, interrupt, a failed and a multi-child collab call, `write_stdin` or a long shell run, a multi-file `apply_patch`, and image generation.
2. Drop `ephemeral` for those scenarios and commit each scrubbed rollout beside its stream, under the scrub guard OW-demuwi built.
3. Run it on the installed Codex with `-m gpt-5.6-luna`, and have each run print and record a census by item kind: `item/completed` counted by `params.item.type` on the stream, and rollout lines counted by `(type, payload.type)`.
   OW-pukado's census diff is still open and has nothing to compare against for a scenario with no earlier fixture, so this pass does not wait on it.
4. Add one conformance test per scenario: the preview of the rollout and the reducer over the stream produce the same tool names, pairing and stop reasons, with every allowed difference listed explicitly — which is where OW-wapage's and OW-kelise's decisions get recorded.

The obvious alternative, routing the preview through a session-less app-server's `thread/turns/list` so there is one mapper, is not taken here: a preview would have to load the thread on an app-server with `thread/resume` before reading it (`docs/MANUAL_TESTING.md`, "A copying artifact, not a CLI fact"), where today it reads a file.
`thread/turns/list` itself is not the obstacle — at `itemsView: "full"` it answered items identical to a full-history read (same document, "What pages the same turns"); `notLoaded` is only a view setting.
One cheap census belongs in the same pass and is unmeasured: rollouts on 0.154 and later carry `event_msg` `item_completed` records with capitalised item types; count whether they cover every item kind well enough to feed `mapItem` directly, and record the answer with its version.
Pi fixture drift (fixtures stamped 0.84.x against an installed 0.87.1) has no card; say in the close note whether this pass covered it or file one.

## Done when

The new fixtures and rollouts are committed, the conformance tests exist and run in `bun run check`, and each scenario's failing rows are listed as the known difference of the card that owns them; fixing a row is that card's work, not this one's.
Whatever the tests show, each card named above is amended to say what its row showed, or that this pass produced no row for it and why, and OW-19, OW-kehose and OW-guyunu are amended from blocked-on-evidence to the decision each now is.
Whether OW-wujuda closes under the full re-capture is the owner's call; its own done condition says drift alone re-captures nothing.

## Amended 2026-09-30 at execution

A dry-run reader checked this card against the tree at 5d096a8 before dispatch; the edits above are what drifted, and what follows is what it found that the card did not say.

- `capture_codex` already runs every Codex capture in a throwaway `CODEX_HOME` (`make_state_home`) that it deletes at the end, so dropping `ephemeral` writes the rollout under that home's `sessions/` and never touches `~/.codex`; the rollout must be copied out before the `shutil.rmtree(home ...)`.
  `resources/probes/fork_probe.py` already has the pieces: `codex_rollout_for`, `codex_rollout_lines` (splits on bytes because of U+2028), and a rollout scrub including `scrub_content` for the skills manifest that once leaked home paths.
- A rollout carries `event_msg` `token_count` records with `rate_limits`, which neither `scrub()` nor the telemetry check in `src/fixture-scrub.test.ts` covers; this pass scrubs them and extends that guard.
- Re-capture the existing `compact` scenario with its rollout too, so OW-wapage's row exists.
- The scenario recipes on record: plan mode in `resources/probes/hydrate_window_probe.py` (`experimentalApi` on `initialize`, `collaborationMode {mode: "plan", ...}` on `turn/start`; keep the prompt short, a 0.156.0 run streamed 13,977 characters), a mid-turn abort in `resources/probes/agentpane_live_support.py` (`LONG_PROMPT`, `ABORT_AT_CHARS`), a forced `apply_patch` and a slow shell run in `hydrate_window_probe.py`.
  Nothing in the repo says how to provoke a failed collab call or image generation on `gpt-5.6-luna`.
- A scenario that cannot be provoked on the installed Codex with the pinned model is recorded as such in `docs/MANUAL_TESTING.md`, with what was tried and the version, and does not hold this card open; its owning card is amended to say so.
- As of `codex-cli 0.156.0` an interrupted turn's partial reply was not kept in the rollout (`docs/MANUAL_TESTING.md`, "Codex does not keep the partial reply."), so the interrupt scenario's assistant text is a permanent listed difference, not a defect.
- The comparison projects each side to role sequence, tool names, call-to-result pairing, `isError` and `stopReason`; timestamps, usage and model identity differ by design and are excluded.
  Where a card's disagreement sits outside that projection (OW-zabiko's preamble is result text, OW-4 is how a client draws the edit), its amendment says what the rollout shows by inspection.
- The rows `webSearch`, `mcpToolCall` and `dynamicToolCall` get no scenario in this pass; `docs/DESIGN.md`'s "have no capture yet" row is narrowed to them, not retired.
