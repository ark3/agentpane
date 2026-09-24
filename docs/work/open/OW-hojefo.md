---
labels: [unverified]
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
