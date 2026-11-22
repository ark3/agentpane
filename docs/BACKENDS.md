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
  D18: third group, **licenses absent code** (#79).
- **Session file, model, level and name after a fork**, from `fork()`'s `get_state`; exempt.
  Event: none; a fork answered `get_state` at the spawn's model and level with no event (`pi 0.87.1` and `1.2.0`, OW-sinoha, OW-dojebo and OW-vijine, in the docblocks on `chosenModel` and `thinkingLevel`).
  Order: relied on, nothing arriving between the `fork` reply and this answer, which would go out under the parent's ref.
  Evidence: "Fork" above, its sentence citing OW-dutute: `pi 0.87.1` and three runs on `pi 1.2.0`.
  D18: third group, **licenses absent code** (#79).
- **Transcript after a fork**, from `get_messages` in `hydrateMessages`, a replace that truncates; exempt.
  Event: none; `fork` emits no message events.
  Order: relied on, the abandoned turn's last events arriving before the `fork` reply and nothing between it and the `get_messages` answer (D34 point 2).
  Evidence: "Fork" above, its sentence citing OW-dutute: `pi 0.87.1` and three runs on `pi 1.2.0`.
  D18: third group, **licenses absent code** (#79).
- **`isStreaming: false` after a fork**, written by `fork()` after its replies rather than from an event.
  Event: `agent_settled`.
  Order: `agent_settled` came before the `abort` reply that `fork()` awaits first, in all 22 runs of `docs/MANUAL_TESTING.md` OW-yewiku (`pi 1.2.0`), and before the `fork` reply in OW-dutute (`pi 0.87.1`) and OW-tigaye (`pi 1.2.0`), so the write moves nothing on those versions; not relied on.
  D18: first group.
- **Model and reasoning**, from `setModel`'s `set_model` reply.
  Event: none (as above).
  Order: the `thinking_level_changed` that `set_model` resets the level with came before its reply on `pi 0.87.1` (`docs/MANUAL_TESTING.md` OW-ruzuhu); `settingModel` holds it until the reply, and a level arriving after the reply is applied at once, so neither order is relied on (OW-zasozo).
  D18: first group.
- **Name**, from `setName`'s `set_session_name` reply.
  Event: `session_info_changed`, emitted at every rename as of `pi 1.0.0` (read at the source, in the docblock on `name`) and documented in `pi 1.5.2`'s `docs/json.md`; not read.
  Order: not measured; the reply alone is used, so none is relied on.
  Evidence: the reply's success on `pi 0.85.1` (`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire").
  D18: first group.
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
No entry here licenses absent code.

- **Model**, from `setModel`'s `set_model` reply.
  Event: an `isReplay` user event reading ``Set model to `sonnet (claude-sonnet-5)` `` came ahead of each reply after a turn and on a resume, and none before a fresh session's first turn (`resources/fixtures/claude/set-model.jsonl`, `claude 2.1.280`; `docs/MANUAL_TESTING.md` OW-hiligu; none in `control-discovery.jsonl`, `claude 2.1.238`); the reducer drops it.
  The next turn's `system`/`init` names the model again, with its `[1m]` variant, and the adapter takes it (`claude 2.1.280`, OW-lizupu).
  Order: not relied on, since the `isReplay` event is dropped and `init` comes only with a turn.
  D18: first group.
- **Effort, and the model a store or nothing named**, from `readSettings`'s `get_settings` at start and after `setModel` and `setEffort`, mapped through `initialize`'s list; exempt.
  Event: none for the effort, which neither `init` nor an `assistant` event carried on `claude 2.1.280` (the docblock on `ClaudeReducer`'s effort field, OW-hokaye); for the model, `init` with the next turn.
  Order: none relied on.
  D18: first group.
- **Name**, from `setName`'s `rename_session` reply.
  Event: none recorded; the runs read the store, which gained a `custom-title` line, and whether stdout carries an event was not recorded (`claude 2.1.270`, "All three backends rename an attached session over the wire", and `claude 2.1.287`, OW-kametu).
  Order: none relied on.
  D18: first group.

Exempt and writing no session state: `initialize`'s model list; `interrupt`, whose turn ends at its `result` (`resources/fixtures/claude/interrupt.jsonl`, `claude 2.1.238`); `apply_flag_settings`, whose effort is read back from `get_settings`.

## Codex

### Replies and events

Each fact `CodexAdapter` (`src/server/adapters/codex/adapter.ts`) and `CodexReducer` (`reducer.ts`) write from a JSON-RPC reply, laid out as under Pi's.
"The wire captures" are the 12 Codex fixtures under `resources/fixtures/codex/` that record app-server's stdout, every one but `fork.jsonl`, which is a rollout: `codex-cli 0.147.0` for `text`, `tool-read`, `tool-edit` and `compact`, `0.153.4` for `subagent`, and `0.157.1` for the other seven.
They carry 15 `turn/start` replies, four of them in `compact.jsonl`, and no `thread/resume`.

- **Thread id**, from the `thread/start` or `thread/resume` reply, into the adapter's `threadId`, the reducer's identity and the connection's claim; exempt, since it names what the request created or asked for.
  Event: `thread/started`, which the reducer also takes when it holds no id.
  Order: the `thread/start` reply came before `thread/started` in all 12 wire captures, `codex-cli 0.147.0` to `0.157.1`; the reducer takes the first either way, so none is relied on.
  Whether a `thread/resume` sends `thread/started` is in no capture.
  D18: first group.
- **Model, provider and effort the reducer names**, from the `thread/start` or `thread/resume` reply's `model`, `modelProvider` and `reasoningEffort`, under the rollout's last `turn_context` (D23, the docblock on `effort`); before each `turn/start` the adapter sets them from its own choice, which is no reply.
  Event: `thread/started` carries `thread.modelProvider`, which the reducer takes too; `thread/settings/updated` carries `model` and `effort`, and the reducer drops it.
  It came once in the wire captures, in `plan.jsonl` (`codex-cli 0.157.1`), ahead of the `turn/start` reply, reporting that turn's `collaborationMode` with `effort: null`; on `codex-cli 0.156.0` none followed a `turn/start` overriding the effort (`docs/MANUAL_TESTING.md` OW-kokalo).
  Order: none relied on.
  D18: second group, behind D23.
- **Name at attach**, `thread.name` from the `thread/start` or `thread/resume` reply.
  Event: none; `thread/name/updated` reports a rename only.
  Order: none relied on.
  Evidence: read from the code at f6d01c95.
  D18: first group.
- **Name after a rename**, from `setName`'s `thread/name/set` reply.
  Event: `thread/name/updated`, which the adapter takes too.
  Order: the reply came first, then the event, on `codex-cli 0.154.0` and mid-turn on `0.160.0`, 4.961s against 4.967s (`docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire" and OW-kametu); either order sets the same name, so none is relied on.
  D18: first group.
- **The running turn**, from the `turn/start` reply's `turn.id`, into `turnBusy` and, where nothing contradicts it, `turnId`; `turnBusy` itself is set as a submission before the request goes out.
  Event: `turn/started` names the same id, and `turn/completed` ends it.
  Order: the reply came before `thread/status/changed` `active` and `turn/started` for all 15 `turn/start` replies in the wire captures, `codex-cli 0.147.0` to `0.157.1`.
  Not relied on: `pendingTurnCompletions` covers lifecycle lines handled before the awaited reply resumes (`codex/adapter.test.ts`, "does not revive a turn completed in the same chunk as turn/start response").
  D18: first group.
- **The running turn at a re-attach**, from the last `thread/turns/list` page's `inProgress` turn, into `isStreaming`, compaction and, through the `running-turn` effect, `turnId` and `turnBusy` (`CodexReducer.hydrate`); exempt as a listing, though it writes session state.
  Event: none, since `thread/resume` replayed no `turn/started` on `codex-cli 0.156.0` (`docs/MANUAL_TESTING.md` OW-dutute).
  Order: relied on, no line arriving between a page's request and its answer (`CodexReducer.pageRequested`), measured on `codex-cli 0.156.0` (OW-dutute, OW-dirazu).
  D18: third group, **licenses absent code**, a delta laid on twice; #78 deletes this path, so #79 asserts nothing here.
- **Turn order**, `turnOrder`, from each `thread/turns/list` reply at hydrate and in `listForkPoints`; exempt.
  Event: `turn/started` carries each new turn's id, in every wire capture; not read for this.
  Order: none relied on.
  D18: first group.
- **Compaction**: `compact()` writes `"requesting"` before `thread/compact/start` and clears it on a failed reply; `item/started` for `contextCompaction` owns `running`, and its `item/completed` or `turn/completed` the end.
  Event: those three; for a refused request, not measured.
  Order: the `{}` reply came before the compaction's `turn/started` in `compact.jsonl` (`codex-cli 0.147.0`) and `compact-rollout.jsonl` (`0.157.1`); not relied on.
  D18: first group.
- **An interrupted turn**: `abort()` writes `interruptedTurnId` before `turn/interrupt`, the reply writes nothing, and `turn/completed` clears it.
  Order: the `{}` reply came before `turn/completed` with status `interrupted` in `interrupt.jsonl` (`codex-cli 0.157.1`); not relied on.
  D18: first group.

Exempt and writing no session state: `initialize`; `model/list`; `turn/steer`, whose reply named the steered turn on `codex-cli 0.154.0` (OW-tifuha) and is not read; `thread/fork`, whose reply names the thread the borrower drives.
`setModel` and `setEffort` send nothing: Codex takes both on the next `turn/start`.
