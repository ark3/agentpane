---
labels: [unverified]
closed: done
---

# A Codex fork at the first user message sends no lastTurnId, which by the protocol keeps the whole thread rather than none of it

Noticed 2026-09-22 by OW-buligi's implementer, from the code and the vendored protocol; not run live.
In service of a fork at a user message holding exactly the history before it, on every backend.

`fork()` in `src/server/adapters/codex/adapter.ts` computes `const lastTurnId = index > 0 ? this.turnOrder[index - 1] : undefined` and spreads it into the `thread/fork` params only when defined.
At index 0, the first user message, it therefore sends no `lastTurnId`, and `resources/codex-protocol/v2/ThreadForkParams.ts` says only "When specified, turns after `last_turn_id` are omitted from the fork" — so an unspecified one omits nothing, and the fork would carry the whole parent, the message it was forked at included.
The contract the other backends keep is exclusive of the message (AGENTS.md, "forking at a user message is exclusive of that message", for Pi), so a fork at the first message should be empty.
Load-bearing and unmeasured: what `thread/fork` with no `lastTurnId` actually writes, as of the installed `codex-cli`; `docs/MANUAL_TESTING.md`, "A Codex fork's rollout names where its inherited history ends (OW-buligi)", has the rollout fields (`history_base`, `forked_from_ordinal_exclusive`) that show where a fork's inherited history ends, and `resources/probes/codex_fork_history_probe.py` is the instrument, with the model pinned (`gpt-5.6-luna`).

## Added 2026-09-23 by OW-sababi

A fix that makes this fork keep nothing inherits D23's rule for a fork that keeps no turn (`docs/DESIGN.md`, D23, the paragraph opening "A fork that keeps no turn"): it runs at the parent's model and effort as they stand when cut.
The borrower `fork()` hands back reads its pair from `readCodexLastTurnSettings` in `src/server/sessions/codex.ts`, which finds no `turn_context` in an empty fork, so without a carry it would run at what `thread/resume` answers, `config.toml`'s pair (OW-sayaju); the fix's test covers that too.
The existing test "starts a fork at the model and effort the kept prefix's last turn ran at (D23)" in `src/server/adapters/codex/adapter.test.ts` forks at index 0 with a hand-written `history_base` ordinal naming only the first turn, which a real fork with no `lastTurnId` would not write; it needs revisiting alongside the fix.

## Done when

The behaviour at index 0 is measured and recorded in `docs/MANUAL_TESTING.md` with the version.
If it keeps history the fork should not have, an adapter test in `src/server/adapters/codex/adapter.test.ts` pins whatever the fix sends at index 0 (a fresh thread, or a refusal), red before it; if it keeps none, the comment above `lastTurnId` in `fork()` says so and cites the measurement.

## Close note

Measured on the home server 2026-09-23, `codex-cli 0.156.0`, turns on `gpt-5.6-luna` only, in a temporary `CODEX_HOME`: `thread/fork` with no `lastTurnId` on a two-turn parent kept the whole parent (`history_base.end_ordinal_exclusive` at the file's end, both turns in `thread/read`), and `lastTurnId: ""` or an unknown turn id was refused with `-32600 turn not found`, so no `thread/fork` keeps nothing; a `thread/start` thread writes no rollout until its first turn and cannot be resumed before it.
`CodexAdapter.fork()` in `src/server/adapters/codex/adapter.ts` now, at the first fork point, sends nothing to Codex and returns a `virtual:` ref with `start: { cwd, model, forkOf: { parentId, entryId, effort } }`, Claude Code's session-start shape; the fork's own adapter spawns its own app-server and `thread/start`s at the parent's model, carries `forkOf.effort` on every `turn/start` (D23, "A fork that keeps no turn"), and the session manager renames the ref at attach as it does for a virtual session.
Three tests failed first against the old code (a `thread/fork` sent at index 0, the config's `high` effort instead of the parent's `low`, and the fork's ref not `virtual:`); tests that forked at the first turn now fork at the second; `bun run check` passes on main.
An adversarial reader traced fork, attach, rename and both clients (browser `forkAndSubmit`, Emacs `agentpane--fork-at`) and found no failure; the two stale comments it named, in the `fork` route of `src/server/http/app.ts` and the `ForkResult` docblock, were fixed.
Evidence: `docs/MANUAL_TESTING.md` OW-hojefo section; D23's Codex sentence updated.
Filed from it: OW-wedupe (detaching a Codex session before its first turn previews a rollout-less thread) and OW-riluye (vendored Codex bindings behind 0.156.0).
Unmeasured edge the reader raised at low confidence: a parent started outside agentpane under a non-default `model_provider` would fork onto `config.toml`'s provider, since `thread/start` names only the model.
