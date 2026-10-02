---
labels: [defect]
---

# A Codex assistant message's model comes from one reducer-wide identity at remap time, so a restart restamps every past turn with the last turn's model

Found 2026-10-01 by the adversarial read of OW-9's fix, and filed as its sibling: OW-9 re-syncs the stamp at the one site a new turn begins, and this card moves the stamp's owner to the turn and retires that re-sync.

## What holds today

`CodexReducer.remap` in `src/server/adapters/codex/reducer.ts` builds its `MapContext` from `...this.identity`, and `assistant()` in `src/server/adapters/codex/mapping.ts` copies `ctx.model` onto every assistant message, plan, reasoning, tool call and imageView it maps.
So a message carries whatever identity the reducer holds at that slot's last remap, not the model its turn ran on; neither a `Slot` nor a turn records a model of its own.
OW-9 made the live stream come out right by having `CodexAdapter.submit` in `src/server/adapters/codex/adapter.ts` call `this.reducer.setIdentity({ model: this.model, reasoningEffort: this.effort })` before `turn/start`; that works only because a live slot's last remap happens inside its own turn.

The cases it leaves, every one of them present before OW-9 and true of effort in the same way:

- **Hydrate restamps all history.**
  `CodexAdapter.start` and `startBorrowed` call `reducer.setIdentity` before `reducer.hydrate`, and on a resume that model is `opts.model`, else `stored.model` (the last `turn_context`, from `readCodexLastTurnSettings` in `src/server/sessions/codex.ts`), else the response's.
  `hydrate` sends every listed item through `applyItem` and `remap` under that one identity, so after a restart, a re-attach or a fork every past assistant message names the last turn's model, or the one chosen at resume.
  A session that switched models mid-thread shows the right per-turn models live and collapses to one on restart.
- **A re-attach window stamps `"unknown"`.**
  On the shared-connection path, `adoptConnection` seeds only `threadId`, so the identity stays the reducer's `DEFAULT_MODEL` through the `thread/resume` round trip and `readStoredTurn`; an item of a still-running turn whose `item/started` and `item/completed` both land in that window is stamped `"unknown"`, and `hydrate` keeps that live slot without remapping it.
- **A rerouted turn names the model it asked for.**
  `model/rerouted` (`ModelReroutedNotification`: `turnId`, `fromModel`, `toModel`, `reason`) falls through `CodexReducer`'s notification switch to `default:` and is dropped.

## Where the true owner lives

The wire carries no per-turn model: as of `codex-cli 0.156.0` `Turn` has no model field, and `thread/settings/updated` does not report a `turn/start` override (`docs/MANUAL_TESTING.md`, OW-kokalo).
The rollout does: every turn writes a `turn_context` record with `model`, `effort` and `turn_id`, and in the `multi-patch`, `compact-rollout` and `plan` fixtures under `resources/fixtures/codex/` `turn_context.turn_id` equals the wire's `turn/started` id; a compaction turn writes none.
`readCodexLastTurnSettings` already walks those records and keeps only the last; the per-turn map is the same walk keeping all of them by turn id.
Whether a running turn's `turn_context` is on disk before the turn finishes is unmeasured, and the fix must not depend on it without measuring it.

## Done when

Tests in `src/server/adapters/codex/` show each of these red first and green after:

- a resume hydrating two turns whose stored `turn_context` records name different models stamps each turn's assistant messages with its own model;
- a turn whose `turn/start` carried a selected model stamps that model, with no `setIdentity({ model })` call left in `submit`;
- a `model/rerouted` for the running turn makes that turn's later-mapped messages carry `toModel`;
- an item mapped during the re-attach window before identity arrives carries no `"unknown"` model once hydration completes.

The reducer-wide `identity.model` is no longer what `remap` stamps on a message: the model comes from the slot's turn, and OW-9's re-sync line in `submit` is gone (effort may keep a reducer-wide default where no turn names one, but say so at the site).
`bun run check` passes.
