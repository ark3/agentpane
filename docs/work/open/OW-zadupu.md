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
`src/server/sessions/preview.test.ts` says in its header that the preview tests use made-up store lines for that reason.
The live-side cards are blocked on the same absence: OW-19 (`plan`), OW-kehose (image generation), OW-guyunu (failed and multi-child collab calls), OW-yobuyi's live half (interrupt), and the rows `docs/DESIGN.md`'s "Codex `ThreadItem` → `AgentMessage` mapping" section says "have no capture yet" (`plan`, `webSearch`, `mcpToolCall`, `dynamicToolCall`).
OW-wujuda and OW-pukado are the version-drift side of the same fixtures: as of this sweep `codex --version` reported `codex-cli 0.157.1`, against fixtures captured on 0.147.0.

## The change

1. Extend `capture_fixtures.py` with scenarios for plan, interrupt, a failed and a multi-child collab call, `write_stdin` or a long shell run, a multi-file `apply_patch`, and image generation.
2. Drop `ephemeral` for those scenarios and commit each scrubbed rollout beside its stream, under the scrub guard OW-demuwi built.
3. Run it on the installed Codex with `-m gpt-5.6-luna`, with OW-pukado's census diff printing what moved.
4. Add one conformance test per scenario: the preview of the rollout and the reducer over the stream produce the same tool names, pairing and stop reasons, with every allowed difference listed explicitly — which is where OW-wapage's and OW-kelise's decisions get recorded.

The obvious alternative, routing the preview through a session-less app-server's `thread/turns/list` so there is one mapper, is closed for now: `docs/MANUAL_TESTING.md` records that at `notLoaded` every turn came back with no items, and that paginated rollouts answered zero turns before a `thread/resume`.
One cheap census belongs in the same pass and is unmeasured: rollouts on 0.154 and later carry `event_msg` `item_completed` records with capitalised item types; count whether they cover every item kind well enough to feed `mapItem` directly, and record the answer with its version.
Pi fixture drift (fixtures stamped 0.84.x against an installed 0.87.1) has no card; say in the close note whether this pass covered it or file one.

## Done when

The new fixtures and rollouts are committed, the conformance tests exist and run in `bun run check`, and each scenario's failing rows are either fixed or listed as the known difference of the card that owns them.
Whatever the tests show, each card named above is amended to say what its row showed, and OW-19, OW-kehose and OW-guyunu are amended from blocked-on-evidence to the decision each now is.
Whether OW-wujuda closes under the full re-capture is the owner's call; its own done condition says drift alone re-captures nothing.
