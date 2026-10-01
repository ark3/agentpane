---
labels: [change, sweep-0929]
closed: done
---

# The Codex preview rebuilds each item from rollout scripts and response items, though the rollout's own item_completed records hold every item the live stream completed; it should translate those into mapItem, and keep today's parser only for rollouts that lack them

Filed 2026-09-30 from OW-zadupu's finding, as the structural fix to its own headline: Codex items reach the transcript through two unconnected mappers, live `mapItem` in `src/server/adapters/codex/mapping.ts` and the preview's `extractStoreTurn` in `src/server/sessions/codex.ts`.
It is meant to retire, for every rollout that carries item records, the preview defects OW-zadupu's conformance test found; OW-bomere and OW-mehezu close moot under it, and OW-zabiko, OW-kelise and OW-yobuyi are amended to point here.

## What OW-zadupu found

On `codex-cli 0.157.1` the rollout's `event_msg` records of type `item_completed` covered every item the thread's own stream completed, with the same ids in the same order, in a different serialization (capitalised types, snake_case fields, argv commands, `file://` cwd, path-keyed diffs); `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)".
Read again on 2026-09-30 against the seven `resources/fixtures/codex/*.rollout.jsonl`, the records carry exactly what the preview's known defects lack:
- `CollabAgentToolCall` has `status` (`"failed"` on `collab-failed`), `tool` (`spawn_agent`, `wait`), the spawn's `prompt`, `receiver_agents` with nicknames, and `agents_states` mapping each child to its outcome (`{"completed": "Hello"}`, `"not_found"`). The preview today draws these as `exec` scripts with `isError: false` (OW-kelise, OW-bomere).
- `FileChange` has `changes` keyed by path, each with its `unified_diff` or added `content`, and `CommandExecution` has `aggregated_output` with no `Script completed` preamble, where the preview draws both as raw `exec` scripts (OW-zabiko).
- `UserMessage` records exist only for what the user typed: the `<environment_context>`, `<subagent_notification>` and `<turn_aborted>` user-role `response_item`s have none, so the synthetic-prefix list `SYNTHETIC_USER_PREFIXES` has nothing to filter (OW-mehezu, and the stored `user <turn_aborted>` row in OW-yobuyi).
- The kinds seen were `UserMessage`, `AgentMessage`, `Reasoning`, `CommandExecution`, `FileChange`, `CollabAgentToolCall`, `Plan` and `ContextCompaction`.

## Which rollouts carry them

Counted on 2026-09-30 over the home server's real `~/.codex/sessions` (read-only): every rollout from `0.147.0`, `0.153.0`, `0.153.4` and `0.156.0` carries `item_completed` records; on `0.150.1` 19 of 34 do, and the 15 that do not have `session_meta.source` `vscode` or a subagent spawn and hold their items only as `response_item`s and legacy `event_msg`s (`agent_message`, `user_message`, `patch_apply_end`); on `0.154.0` 32 of 44 do, and the 12 that do not hold no turn at all.
So whether a rollout carries item records is decided per file, not by version, and the preview needs both paths.

## The change

For a rollout that carries `item_completed` records, the preview builds its items by translating each record into the `ThreadItem` shape `mapItem` takes and calling `mapItem`, so live and preview share one mapper; the translation is per kind and is all the new code should be.
For a rollout that carries none, today's `extractStoreTurn` path stays as it is, and its known differences are accepted for those files (a first cut; the owner may revisit).
What the preview takes from records other than items stays where it is: turn boundaries and settings (`turnSettings`), token usage, compaction (`compactionTurnFor`), and a fork's history base (`historyBase`); check whether a forked thread's rollout repeats the parent's `item_completed` records, which decides what `historyBase` cuts.
The app-server bindings in `resources/codex-protocol/v2/` type `mapItem`'s input; whether anything types the rollout's snake_case items is for the executor to find, and a kind with no typed source is translated from the committed fixtures.
A kind the translation does not know (`webSearch`, `mcpToolCall`, `dynamicToolCall` and image generation have no capture; DESIGN's "have no capture yet" row) is skipped with nothing drawn, or drawn as today's path draws its `response_item`, whichever is less code; say which in `extractStoreTurn`'s docblock.

## Done when

- `KNOWN_DIFFERENCES` in `src/server/sessions/codex-conformance.test.ts` holds no entry keyed to OW-bomere, OW-mehezu, OW-zabiko or OW-kelise, and the preview half of OW-yobuyi's `interrupt` entry (`preview: ["user <turn_aborted>"]`) is gone. The test fails while an entry it no longer needs remains, which is the red-then-green. Any entry left is keyed to a card that still owns it, with a sentence saying why.
- A test in `src/server/sessions/codex.test.ts` or `preview.test.ts`, red first, previews a rollout that carries no `item_completed` records (a trimmed copy of a fixture's `response_item` lines will do) and gets today's output, so the fallback path is pinned.
- `SYNTHETIC_USER_PREFIXES`, `execScriptArguments` and the hardcoded `isError: false` either have no caller on the item-record path or are gone; whatever stays serves the fallback alone, and its docblock says so.
- `extractStoreTurn`'s docblock (or the module's) states the two paths and which rollouts take each, with the counts above as the measurement.
- `bun run check` passes.

Afterwards, close OW-zabiko and OW-kelise `--done` or `--moot` by what remains of each: OW-kelise also asks for a link to the child thread, which is presentation and may belong with OW-novuye and OW-gakide instead.
OW-yobuyi keeps its live half and its stored aborted marking.

## Close note

Landed on main as 8881fc7, 34348a8, 6c0f63e and 321318f.
The Codex preview now draws a rollout from its `item_completed` records, each translated by `threadItem` in `src/server/sessions/codex.ts` into the `ThreadItem` live `mapItem` takes, so live and preview share one mapper; `extractStoreTurn` stays as the fallback, and its docblock states the rule and the counts.
The rule is narrower than the card's "carries item records", because the card's premise that the records are a full copy held only as measured on `codex-cli 0.157.1`: a rollout takes the item path when one of its records translates and it stores no `function_call` in the `collaboration` namespace.
Measured over the home server's 119 rollouts on 2026-10-01: 17 on 0.150.1 carry only `SubAgentActivity` records, and the 39 rollouts on 0.150.1 through 0.154.0 that store collab calls as function calls have no record for spawns and an empty `wait` record for every wait (179 of 179), so drawn from records they would lose 131 calls; 50 of 119 take the item path.
`shellJoin` ports Rust `shlex` 1.3.0 `quote`, pinned against the live command strings of four fixtures, after the first cut's quoting differed from live on 495 of 926 real argvs.
Verified: `KNOWN_DIFFERENCES` in `codex-conformance.test.ts` is empty but for OW-yobuyi's live half of `interrupt` (its stale entries failed the test until removed); a new `preview.test.ts` case pins the fallback on a capture stripped of its records, and another the collab rule, each watched red first; an adversarial reader compared old and new previews over every real rollout and the seven captures field by field against the reducer, which is what found the collab and quoting regressions fixed in the later commits; `bun run check` passed on main (1607 tests).
Left: 17 real 0.153.x subagent rollouts on the item path no longer draw the parent messages they copy inline, filed as OW-hagito; the item-path translation skips kinds with no capture (webSearch, mcpToolCall, dynamicToolCall, image generation) and draws nothing for them.
