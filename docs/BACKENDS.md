# Backends

What each backend CLI was measured to do, and on which version.
Each fact carries the version it was measured on (`AGENTS.md`, "Evidence"), and D18 says which ones are defended against time.
The run-by-run evidence is in `docs/MANUAL_TESTING.md`; the findings that established the design are its "HANDOFF findings 1–49".

## Pi

### Fork

Pi fork behaviour, first measured on the work laptop (2026-08-20, `pi 0.84.2`) and re-measured on the home server twice on 2026-09-15 (`pi 0.85.1`) and twice on 2026-10-14 (`pi 1.2.0`), on `deepseek/deepseek-v4.1-flash`: forking at a user message is exclusive of that message, and forking during a streaming turn succeeds while the turn stops — `isStreaming` goes false and `agent_settled` arrives.
Streamed text is **not** discarded: on the second 0.85.1 run, with the probe cell holding the fork until forty `text_delta`s had accumulated and re-reading the count at the instant the request went out, 47 deltas were on the wire and the file the turn was streaming into held the reply's first 447 characters (OW-sededi), and the two 1.2.0 runs read 55 and 53 deltas and 551 and 519 characters (OW-vijine).
So what the fork costs is the rest of the reply and the branch it was on, not the bytes already written.
The empty assistant entry the first 0.85.1 run read in that file was a fork that landed about 2.2s in, before any text existed; that run gated on `agent_start` alone and could not tell the two apart, and the 0.84.2 run earned even less — it forked at the first user message, where exclusivity empties the new branch whatever became of the turn, and never opened the streamed-into file.
The 0.85.1 and 1.2.0 runs also read the fork's moved-to session file as already on disk when `fork` returned, carrying the rewound prefix — samples at the instrument that had once read `false`, and all of them forks at the second user message.
A fork at the first user message keeps no user or assistant message, and on `pi 1.2.0` its file was not on disk when `fork` returned and was written with the branch's first user message (OW-tigaye).
As of `pi 0.87.1`, and in three runs on `pi 1.2.0`, the abandoned turn's last events, `agent_settled` among them, all arrived before the `fork` response, and nothing arrived between it and the `get_messages` answer that followed (OW-dutute), which is why `hydrateMessages` may replace the transcript.
See `docs/MANUAL_TESTING.md` OW-sededi, OW-gajesu and OW-vijine, and OW-yudoni for what the earliest run did and did not show.

On `pi 1.5.2` (home server, 2026-11-19, `deepseek/deepseek-v4.1-flash`), a stop sent to a session with no turn running, `clear_queue` and then `abort`, answered both with `success: true`, `clear_queue` with both queues empty, and Pi wrote nothing else but one `queue_update` naming both queues empty; a `fork` at the first user message after it succeeded and moved `sessionFile`.
That is the stop `PiAdapter.fork` sends ahead of every fork (D30), and `resources/probes/pi_idle_stop_fork_probe.py` repeats the run; see `docs/MANUAL_TESTING.md`, "A Pi stop with no turn running".

### Resume

On `pi 1.5.2` (home server, 2026-11-22), neither a new session's first prompt nor a later resume of it moved its session file: the create named the JSONL path at start, the one-word turn left it there, and an attach of that path through agentpane, with no prompt, answered the same path and carried no other.
D35 point 1 rests on it, since a resume that moved the file would list the session twice; `resources/probes/pi_attach_rename_probe.ts` repeats the run, and `docs/MANUAL_TESTING.md`, "Attaching a stored Pi session makes no rename", records it.

### RPC framing

**Pi RPC framing is LF-only.**
Split on `\n` only; do not use Node `readline` (it also splits on U+2028/U+2029, which are valid inside JSON strings).
See Pi's `docs/rpc.md` "Framing".

### Replies and events

Each fact `PiAdapter` (`src/server/adapters/pi/process.ts`) writes from a reply, the event that carries the same fact, the order it relies on, its evidence and its D18 group (D34 points 3 and 4).
"Exempt" is D34 point 3's reading of D28: a value only the requester asked for, or a reply naming what its request created.
An entry marked **licenses absent code** is in D18's third group, and #79 gives it a runtime assertion.
As of the installed `pi 1.5.2`'s `docs/json.md` (read at the package, not run), Pi's state events are `queue_update`, `entry_appended`, `session_info_changed` and `thinking_level_changed`, and none names a model or a session file.

- **Session file, model, level and name at start**, from `start()`'s `get_state`; exempt.
  Event: none at start; `thinking_level_changed` and `session_info_changed` report only a change, and no event names a model or a file.
  Order: none relied on.
  Evidence: `get_state` named the file at start on `pi 0.84.1`, `0.85.1`, `0.87.1` and `1.2.0` (HANDOFF finding 41, `docs/MANUAL_TESTING.md` OW-bohodu and OW-tigaye).
  D18: first group.
- **Session file after the first prompt**, from `submit()`'s `get_state`, only for a Pi that named none at start; exempt.
  Event: none.
  Order: none relied on.
  Evidence: never reached on `pi 0.84.1` to `1.2.0`, which all named the file at start (as above); read from the code at f6d01c95.
  D18: first group.
- **Transcript on a resume**, from `get_messages`, `get_entries` and `get_available_models` in `hydrateMessages`, which replaces the transcript; exempt.
  Event: none, since nothing replays a stored session (D3).
  Order: relied on, nothing arriving between `start()`'s `get_state` and the `get_messages` answer; the replace would drop it.
  Evidence: nothing arrived on `pi 0.87.1` and in three runs on `pi 1.2.0` (`docs/MANUAL_TESTING.md` OW-dutute and OW-vijine).
  D18: third group, **licenses absent code**, asserted since #79: an event that changes the reducer's state from the resume's `get_state` answer to the end of `hydrateMessages` raises a session error naming it, once per window (`PiAdapter.hydrateWindow`, checked in `handleLine`).
- **Session file, model, level and name after a fork**, from `fork()`'s `get_state`; exempt.
  Event: none; a fork answered `get_state` at the spawn's model and level with no event (`pi 0.87.1` and `1.2.0`, OW-sinoha, OW-dojebo and OW-vijine, in the docblocks on `chosenModel` and `thinkingLevel`).
  Order: relied on, nothing arriving between the `fork` reply and this answer, which would go out under the parent's ref.
  Evidence: "Fork" above, its sentence citing OW-dutute: `pi 0.87.1` and three runs on `pi 1.2.0`.
  D18: third group, **licenses absent code**, asserted since #79: an event that changes the reducer's state from the `fork` answer to the end of `hydrateMessages` raises a session error naming it, once per window (`PiAdapter.hydrateWindow`, checked in `handleLine`).
- **Transcript after a fork**, from `get_messages` in `hydrateMessages`, a replace that truncates; exempt.
  Event: none; `fork` emits no message events.
  Order: relied on, the abandoned turn's last events arriving before the `fork` reply and nothing between it and the `get_messages` answer (D34 point 2).
  Evidence: "Fork" above, its sentence citing OW-dutute: `pi 0.87.1` and three runs on `pi 1.2.0`.
  D18: third group, **licenses absent code**, asserted since #79: an event that changes the reducer's state from the `fork` answer to the end of `hydrateMessages` raises a session error naming it, once per window (`PiAdapter.hydrateWindow`, checked in `handleLine`).
- **`isStreaming: false` after a fork**, which `fork()` does not write from its replies since #81: the abandoned turn's `agent_settled` carries it.
  Order: relied on, `agent_settled` arriving before the `fork` reply; it came before the `abort` reply that `fork()` awaits first, in all 22 runs of `docs/MANUAL_TESTING.md` OW-yewiku (`pi 1.2.0`), and before the `fork` reply in OW-dutute (`pi 0.87.1`) and OW-tigaye (`pi 1.2.0`).
  D18: third group, **licenses absent code**, asserted since #79: one arriving from the `fork` answer to the end of `hydrateMessages` raises the fork window's session error (`PiAdapter.hydrateWindow`), and still settles the session.
- **Model and reasoning**, from `setModel`'s `set_model` reply.
  Event: none (as above).
  Order: the `thinking_level_changed` that `set_model` resets the level with came before its reply on `pi 0.87.1` (`docs/MANUAL_TESTING.md` OW-ruzuhu); `settingModel` holds it until the reply, and a level arriving after the reply is applied at once, so neither order is relied on (OW-zasozo).
  D18: first group.
- **Name**, which `setName` does not write from its `set_session_name` reply since #80: `session_info_changed` carries it, and the reply only ends the request; the event also carries a rename an extension makes.
  Order: relied on, the event arriving before the reply, so the update goes out before the command's reply (D31 point 3); on `pi 1.5.2` (home server, 2026-11-22, `deepseek/deepseek-v4.1-flash`, a throwaway `PI_CODING_AGENT_DIR`) it came first, naming the name sent, then the reply, and nothing followed in the next 2s, in both of two runs of `capture_fixtures.py --backend pi --scenario rename` (`resources/fixtures/pi/rename.jsonl`), and `setSessionName` emits it before `rpc-mode.js` answers (read at the source).
  D18: third group, not asserted: a Pi that reversed the two would have `sessions/setName` answer before the name's update, a brief reorder, and the name would still land with the event.
- **Level**, which `setEffort` and `fork()`'s re-send do not write from their `set_thinking_level` reply: `thinking_level_changed` carries it.
  Evidence: one `thinking_level_changed` per `set_thinking_level` on `pi 0.87.1` (OW-ruzuhu).
  D18: first group.
- **Compaction**: `compact()` writes `"requesting"` before its request and clears it on a failed reply; `compaction_start` and `compaction_end` own `running` and its end, and a successful reply writes nothing.
  Event: `compaction_start` and `compaction_end`; for a `compact` refused before it starts, not measured.
  Order: both events came before the `compact` reply in `resources/fixtures/pi/compact.jsonl` (`pi 0.84.2`) and `compact-session.jsonl` (`pi 1.2.0`); not relied on.
  D18: first group.

Exempt and writing no session state: `prompt`'s disposition, which for `"handled"` no event followed on `pi 1.2.0` (OW-kokotu); `clear_queue`'s texts; `get_fork_messages`; `get_available_models`.

## Claude Code

### A message written mid-turn

Claude Code mid-turn handling settled live on the home server (2026-09-10, `claude 2.1.267`, explicit `--model haiku`): a stream-json user message written during a turn is acknowledged only after the first `result` and runs as a second turn, while a `steer` control request errors as unsupported.
The adapter therefore rejects `submit()` and `/compact` while a turn is active; see `docs/MANUAL_TESTING.md` OW-jihete.

### A fork spawned mid-stream

Claude Code mid-stream fork behaviour settled live on the home server (2026-09-11, `claude 2.1.268`, explicit `--model haiku`): sampled at four marks spanning 41 to 160 text deltas and again at `result`, the parent's store gains no assistant content until after the turn ends, so a kill mid-turn loses all of it — but the parent turn itself survives a fork spawned as a second child and writes its whole reply durably.
The loss is agentpane's kill, not the CLI's; see `docs/MANUAL_TESTING.md` OW-japuzo.

### Replies and events

Each fact `ClaudeAdapter` (`src/server/adapters/claude/adapter.ts`) writes from a `control_response`, laid out as under Pi's.
A prompt and `/compact` are stdin writes that get no reply: `turnActive`, and compaction's `"requesting"`, are written at the write and ended by events (`result`, `compact_boundary`), read from the code at f6d01c95.
Only the name licenses absent code.

- **Model**, from `setModel`'s `set_model` reply.
  Event: an `isReplay` user event reading ``Set model to `sonnet (claude-sonnet-5)` `` came ahead of each reply after a turn and on a resume, and none before a fresh session's first turn (`resources/fixtures/claude/set-model.jsonl`, `claude 2.1.280`; `docs/MANUAL_TESTING.md` OW-hiligu; none in `control-discovery.jsonl`, `claude 2.1.238`); the reducer drops it.
  The next turn's `system`/`init` names the model again, with its `[1m]` variant, and the adapter takes it (`claude 2.1.280`, OW-lizupu).
  Order: not relied on, since the `isReplay` event is dropped and `init` comes only with a turn.
  D18: first group.
- **Effort, and the model a store or nothing named**, from `readSettings`'s `get_settings` at start and after `setModel` and `setEffort`, mapped through `initialize`'s list; exempt.
  Event: none for the effort, which neither `init` nor an `assistant` event carried on `claude 2.1.280` (the docblock on `ClaudeReducer`'s effort field, OW-hokaye); for the model, `init` with the next turn.
  Order: none relied on.
  D18: first group.
- **Name**, which `setName` does not write from its `rename_session` reply since #85: a `system` `session_title_changed` carries it, and the reply only ends the request.
  Event: `session_title_changed`, its `title` the name, before a first turn and after one on `claude 2.1.328` (`resources/fixtures/claude/rename.jsonl`); the 2.1.270 and 2.1.287 runs read only the store, which gained a `custom-title` line ("All three backends rename an attached session over the wire", and OW-kametu).
  The CLI also sent one unprompted at a `--resume` and at a `--fork-session` spawn of a titled session, naming the stored title, ahead of `get_settings`' reply, so since #85 a resumed or forked session is named at attach (`claude 2.1.328`, `rename.meta.json`'s `follow_on_runs`).
  Order: relied on, the event coming first, 1ms ahead of the reply in both renames; that is what puts the session's update ahead of the command's reply on the socket (D31 point 3), with no wait for the event.
  D18: third group, **licenses absent code**: were a release to send the reply first, the reply would land before the update, a brief reorder rather than a hang; were it to stop sending the event, the rename would answer success and the name would never change, with nothing to say so.
  Not asserted: a reversal costs only that reorder, and an absence is something only a timer could see.

Exempt and writing no session state: `initialize`'s model list; `interrupt`, whose turn ends at its `result` (`resources/fixtures/claude/interrupt.jsonl`, `claude 2.1.238`); `apply_flag_settings`, whose effort is read back from `get_settings`.

## Codex

### Replies and events

Each fact `CodexAdapter` (`src/server/adapters/codex/adapter.ts`) and `CodexReducer` (`reducer.ts`) write from a JSON-RPC reply, laid out as under Pi's.
"The wire captures" are the 12 Codex fixtures under `resources/fixtures/codex/` that record app-server's stdout, every one but `fork.jsonl`, which is a rollout, and the four `settings-*` captures ark3/agentpane#83 added later, cited by name: `codex-cli 0.147.0` for `text`, `tool-read`, `tool-edit` and `compact`, `0.153.4` for `subagent`, and `0.157.1` for the other seven.
The settings captures are all `codex-cli 0.170.0`.
The 14 that carry a `turn/start` reply carry 20, four of them in `compact.jsonl`, three in `settings-1` and two in `settings-4`; `settings-2` and `settings-3` carry none.
The settings captures carry four `thread/resume` replies, two in `settings-1`, a re-attach's and a fork's borrower's, and one cold in each of `settings-2` and `settings-3`, and no `turn/start` follows any of them.

- **Thread id**, from the `thread/start` or `thread/resume` reply, into the adapter's `threadId`, the reducer's identity and the connection's claim; exempt, since it names what the request created or asked for.
  Event: `thread/started`, which the reducer also takes when it holds no id.
  Order: the `thread/start` reply came before `thread/started` in all 14 wire captures that carry one, `codex-cli 0.147.0` to `0.170.0`, as `settings-1`'s `thread/fork` reply did; the reducer takes the first either way, so none is relied on.
  None of the four `thread/resume` replies was followed by a `thread/started`, on `codex-cli 0.170.0`.
  D18: first group.
- **Model, provider and effort the reducer names**, from the `thread/start` or `thread/resume` reply's `model`, `modelProvider` and `reasoningEffort`, under the rollout's last `turn_context` (D23, the docblock on `effort`); before each `turn/start` the adapter sets them from its own choice, which is no reply.
  Event: `thread/started` carries `thread.modelProvider`, which the reducer takes too; `thread/settings/updated` carries `model`, `modelProvider` and `effort`, and the reducer drops it, since it cannot stand in for the replies (ark3/agentpane#83).
  As of `codex-cli 0.170.0` it reached only a connection whose `initialize` set `capabilities.experimentalApi`, which the adapter's does not: on one sending `capabilities: null`, none followed `thread/start`, a `turn/start` overriding the effort, one repeating it, one naming neither, a re-attach's `thread/resume`, a `thread/fork` and its borrower's resume, or a cold `thread/resume` naming no model or naming one (`settings-1` to `settings-3`).
  On one that set it, none followed `thread/start` either, and one came ahead of the reply of each of the two `turn/start`s sent, each changing a setting: `effort: "low"` for an effort override, and `effort: null` for collaboration mode `plan`, as in `plan.jsonl` on `0.157.1`, the one wire capture that carries it (`settings-4`; `docs/MANUAL_TESTING.md`, ark3/agentpane#83).
  On `codex-cli 0.156.0` none followed an effort override on a connection sending the adapter's request shapes (`docs/MANUAL_TESTING.md` OW-kokalo).
  Order: none relied on.
  D18: second group, behind D23.
- **Name at attach**, `thread.name` from the `thread/start` or `thread/resume` reply.
  Event: none; `thread/name/updated` reports a rename only.
  Order: none relied on.
  Evidence: read from the code at f6d01c95.
  D18: first group.
- **Name after a rename**, which `setName` does not write from its `thread/name/set` reply since #82: `thread/name/updated` carries it, and `setName` answers once both have come, so the update goes out before the command's reply (D31 point 3).
  Order: the reply came first, then the event, on `codex-cli 0.154.0` and mid-turn on `0.160.0`, 4.961s against 4.967s (`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire" and OW-kametu); the wait is armed before the request, so either order resolves it, but the event's arrival is relied on.
  D18: third group, **licenses absent code**: were a release to stop sending the event, `setName` would wait until the session closed or app-server exited, holding every verb `SessionManager.#serially` queued behind it, with nothing to say so.
  Not asserted: what would be loud is an absence, which only a timer could see, and agentpane times out no backend answer but a start (D35); a `thread/name/set` reply that never came would hold it the same way.
- **The running turn**, which since ark3/agentpane#84 the adapter takes from `turn/started` alone, into `turnId`, and which `turn/completed` ends; the `turn/start` reply's `turn.id` is not read.
  A gate armed before the request, `CodexAdapter.starting`, holds from `turn/start` until that `turn/started`, refusing a second `turn/start` or `thread/compact/start` meanwhile (`TURN_START_PENDING_ERROR`), and `submit` answers once both the reply and the event have come, so `SessionManager.#serially` holds the next prompt until the turn is live and it steers.
  Order: the reply came before `thread/status/changed` `active` and `turn/started` for all 20 `turn/start` replies in the wire captures, `codex-cli 0.147.0` to `0.170.0`; the gate is released by `turn/started` whichever comes first, but its arrival after every successful reply is relied on.
  Not measured on any version: a `turn/start` after a `thread/resume`, one on a borrowed fork, one with images, and an error reply.
  D18: third group, **licenses absent code**: were a release to stop sending `turn/started` for a turn it ran, `submit` would hold every verb queued behind it, and no turn would be steerable or interruptable.
  Asserted since #84: a same-thread `turn/completed`, or a `thread/status/changed` that is not `active`, arriving while the gate holds raises one session error naming what arrived, and releases the gate (`CodexAdapter.unstarted`).
  Not asserted: total silence after a reply, which only a timer could see; ark3/agentpane#91 is to bound it with a deadline.
- **The running turn at a re-attach**, from the `thread/resume` reply's `thread.status` on a re-attach over a live app-server: `active` refuses the attach with `TurnRunningError`, `turn_running` on both wires, before any page is read (`CodexAdapter.startBorrowed`, D34); it writes no session state, since the refused attach starts nothing.
  Event: none; the resume named no turn and replayed no `turn/started` on `codex-cli 0.156.0` (`docs/MANUAL_TESTING.md` OW-dirazu), and no line arrived between its request and its answer on `0.170.0` (ark3/agentpane#78).
  Measured: `{"type": "active", "activeFlags": []}` mid-turn in all eight samples on `codex-cli 0.156.0`, compaction included (OW-dirazu), and in the one `agentMessage` sample on `0.170.0` (ark3/agentpane#78).
  Order: none relied on.
  D18: third group, **licenses absent code**: were a release's resume to stop reading `active` mid-turn, the re-attach would go through and the reducer would drop the deltas of an item that started before it (`CodexReducer.applyDelta`) with nothing to say so.
  Asserted since #79: on a re-attach whose resume read `idle`, a delta for an item the reducer does not hold, before the next `turn/started`, raises a session error naming the method and item, once (`CodexReducer.reportUnknownDeltas`, armed in `CodexAdapter.startBorrowed`, checked in `applyDelta`); all 5,641 deltas in the wire captures, `codex-cli 0.147.0` to `0.157.1`, followed their `item/started` (counted on 2026-11-21), so a delta for an unknown item is not normal there either, but nothing else relies on it.
- **Turn order**, `turnOrder`, from each `thread/turns/list` reply at hydrate and in `listForkPoints`; exempt.
  Event: `turn/started` carries each new turn's id, in every wire capture; not read for this.
  Order: none relied on.
  D18: first group.
- **Compaction**: `compact()` writes `"requesting"` before `thread/compact/start` and clears it on a failed reply; `item/started` for `contextCompaction` owns `running`, and its `item/completed` or `turn/completed` the end.
  Event: those three; for a refused request, not measured.
  Since #84 `compact()` arms the running turn's gate too, and answers once the compaction's `turn/started` has come, so no prompt takes that `turn/started` for its own.
  Order: the `{}` reply came before the compaction's `turn/started` in `compact.jsonl` (`codex-cli 0.147.0`) and `compact-rollout.jsonl` (`0.157.1`); the gate does not rely on it, but on the event's arrival, as above.
  D18: third group, with the running turn's assertion.
- **An interrupted turn**: `abort()` writes `interruptedTurnId` before `turn/interrupt`, the reply writes nothing, and `turn/completed` clears it.
  Order: the `{}` reply came before `turn/completed` with status `interrupted` in `interrupt.jsonl` (`codex-cli 0.157.1`); not relied on.
  D18: first group.

Exempt and writing no session state: `initialize`; `model/list`; `turn/steer`, whose reply named the steered turn on `codex-cli 0.154.0` (OW-tifuha) and is not read; `thread/fork`, whose reply names the thread the borrower drives.
`setModel` and `setEffort` send nothing: Codex takes both on the next `turn/start`.
