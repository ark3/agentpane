# Probes — reproducible validation evidence

These scripts are the *executable proof* behind the claims in
`docs/HANDOFF.md`. They were run during design validation and can be re-run
any time to re-confirm the agent protocols on the current CLI versions.

## `pi_rpc_probe.sh`

Proves: **Pi's `--mode rpc` emits `AgentMessage`-shaped objects** — the exact
type `pi-web-ui`'s `MessageList` consumes. Run it and inspect the
`message_end` payload; it has `role`, `content` blocks, `usage`, `stopReason`,
`model`, `timestamp`.

```bash
bash pi_rpc_probe.sh
```

Since OW-yezeya, after the run recorded below, it passes `--model openrouter/deepseek/deepseek-v4.1-flash:high`, the ref `AGENTS.md` pins, rather than answering on whatever Pi's settings file names, and prints that flag above the payload's own `model`.

Verified with: `pi` 0.84.1.

## `codex_turn_probe.py`

Proves: **`codex app-server` runs a full turn over stdio** —
`initialize` → `thread/start` → `turn/start` → streaming
`item/agentMessage/delta` → `item/completed` → `turn/completed`.

```bash
python3 codex_turn_probe.py
```

Note: Codex needs a *writable* `CODEX_HOME` with valid auth. The script copies
your real `~/.codex/{auth.json,config.toml}` into a temp home because the
sandbox makes `~/.codex` read-only. It cleans up the temp copy on exit.

It also proves (OW-tifuha) that **`turn/steer` works against a live turn**: fired mid-stream with `expectedTurnId` set to the active turn, it returns that same turn id and its text is answered inside that turn, opening no second turn.
Extend the wait or the prompt if a faster model finishes before the steer lands.

Verified with: `codex-cli` 0.147.0; the steer phase with `codex-cli` 0.154.0 on 2026-09-12.

## `agentpane_codex_smoke.py`

Proves the assembled application path with a real Codex process: build and
serve the production client, create/attach through REST, observe incremental
SSE transcript updates and idle completion, reconnect and verify a repaint
without another native worker, abort a long turn, then shut the server down and
verify the run-scoped worker exited.

```bash
python3 agentpane_codex_smoke.py \
  --workspace /home/asa0717/src/agentpane
```

This makes live model calls. It derives the application checkout from its own
location, creates and removes a temporary writable `CODEX_HOME`, copies only
`auth.json`/`config.toml` without printing them, and inspects only descendants
of the server it starts. It never invokes Pi. Exit 0 plus the emitted JSON
`"result": "pass"` is the acceptance signal.

It creates the session with an explicit `model`, `--model`, defaulting to the `gpt-5.6-luna` that `AGENTS.md` pins: agentpane spawns a bare `codex app-server` and sends no model on `thread/start` unless the session was created with one, so without it Codex answers on whatever the copied `config.toml` names.
`checks.model` records the flag beside the model the thread reported (OW-yehisa).

The abort phase waits for the long turn to hold 20000 characters of its own text before aborting it, and reports `assistant_length_at_abort` off that turn's messages alone (OW-sofige), so a run spends that much output and up to 150 s more than it did; the prompt and the wait are shared with the Pi harness in `agentpane_live_support.py`.
Verified with the change: `codex-cli` 0.157.1 on the home server, 2026-09-30; see `docs/MANUAL_TESTING.md`, "The smoke probes abort the long turn's own text, twenty thousand characters in (OW-sofige)".

Verified with: `codex-cli` 0.157.1 on the home server, 2026-09-30, with the explicit `--model`; see `docs/MANUAL_TESTING.md`, "The Pi smoke probe passes the pinned model, and runs again since OW-letevu (OW-yehisa)".

## `agentpane_pi_smoke.py`

The same assembled application path with a real Pi process, plus the three things only Pi can establish: that the production `direnv exec <workspace> sbox -- pi --mode rpc` chain actually starts an agent (`capture_fixtures.py` deliberately bypasses sbox, so nothing had run this chain until this harness first did), that the session id changes under the client and the superseded id keeps working, and that killing the server reaches an agent two `exec`s down inside `bwrap`.

```bash
python3 agentpane_pi_smoke.py --workspace /home/asa0717/src/agentpane
python3 agentpane_pi_smoke.py --workspace ... --tool-check   # also assert a toolCall block
python3 agentpane_pi_smoke.py --model <ref>                   # default is the model AGENTS.md pins
```

Same guarantees as the Codex harness: temporary writable state dir
(`PI_CODING_AGENT_DIR`), credentials copied by name and never printed,
inspection scoped to this run's server tree. It never invokes Codex.

`--tool-check` is opt-in because it is the most model-dependent criterion --
the model has to choose to call a tool. It passes; it is separated so the
default run stays deterministic.

It passes `--model` explicitly, through the create-session route's `model` field, defaulting to the `openrouter/deepseek/deepseek-v4.1-flash:high` that `AGENTS.md` pins, and records that flag in `model_flag` and `checks.model.flag_passed` beside the model and level read back off the wire (OW-yehisa).

Its abort phase is the Codex harness's: it waits for 20000 characters of the long turn's own text and reports the length off that turn's messages alone (OW-sofige).
Verified with the change: `pi` 0.87.1 on the home server, 2026-09-30, both bare and with `--tool-check`; see the same OW-sofige section.

It keys every wait by the handle the attach reply carried and reads the rename after the first turn, recording in `checks.rename` every ref the handle carried and whether the move came at attach or on the first prompt (OW-niwusi).
Verified with: `pi` 0.87.1 on the home server, 2026-09-30, both bare and with `--tool-check`, with the explicit `--model`, after the move to the handle; see `docs/MANUAL_TESTING.md`, "The live Pi probes follow a session by its handle (OW-niwusi)".
The runs before that move are "The Pi smoke probe passes the pinned model, and runs again since OW-letevu (OW-yehisa)".
Its first runs on that machine were on `pi` 0.85.1, 2026-09-13; see "The Pi smoke probe runs on the home server, end to end through the built server" (OW-moradi) for what that evidence said and the three defects it exposed (OW-guvojo, OW-hahohi, OW-lapuye).

## `agentpane_pi_steer_probe.py`

Proves: **which of D16's three outcomes Pi's mid-turn 202 actually is** (OW-yuyofu).
Copied from `agentpane_pi_smoke.py` rather than added to it — the card asked for a separate vehicle — and shaped after `codex_turn_probe.py`'s steer phase: start a turn that keeps streaming, confirm it is streaming at the instant of the request, post a second prompt carrying a unique marker through the ordinary REST submit route, then read off Pi's own events whether the marker was answered inside the running turn, in a following turn, or never.

```bash
python3 agentpane_pi_steer_probe.py
python3 agentpane_pi_steer_probe.py --skip-build      # reuse dist/client
python3 agentpane_pi_steer_probe.py --model <ref>     # default is the model AGENTS.md pins
python3 agentpane_pi_steer_probe.py --turn tool       # steer into an executing tool batch (OW-nufitu)
```

`--turn tool` (OW-nufitu) measures where the steered text lands inside a tool batch, which the default text turn never calls.
Its first prompt asks for three `bash` calls in one response, sleeping 4, 15 and 25 seconds, and the probe watches the tap rather than the SSE stream, because only Pi's own `tool_execution_start`/`tool_execution_end` show a call executing.
It posts the marker once one call of the batch has ended and another is still executing, taking the cut from that same read of the tap, and `checks.tool_placement` reports, by tap index, where the steered `user` message landed against each call's start, end and `toolResult` and the round's `turn_end`.
That placement is recorded, not asserted; what the mode does assert is that the `queue_update` naming the marker came before some call's `tool_execution_end`, Pi's own evidence that a call was still executing when the steer was accepted, and that the batch finished.
A run that cannot show both has not measured the case and fails.

Two things it does that the other live harnesses do not.

It **taps Pi's stdout**, because none of the discriminating evidence reaches agentpane's SSE wire: `src/server/adapters/pi/reducer.ts` drops `turn_start`, `turn_end`, `agent_end` and `queue_update` as session bookkeeping, and `agent_settled` alone cannot tell a steer from a drained follow-up queue.
The tap is a `pi` shim first on the server's PATH that pipes the real binary through `tee`; stdin, stdout and stderr pass through untouched, and it adds an `sh` and a `tee` to the sandbox tree, which the probe's worker filter reaps along with the agent.
Pi's exit status does not pass through — `sh` reports the pipeline's last stage — which costs this probe nothing because it never reads the agent's exit code, but has to be taken out of the pipeline by anyone copying the shim to assert on how Pi exited.
The tap preserves order, not time — `tee` stamps nothing — so every duration in the record is measured from a stamp taken immediately before the request that caused the event, and positions in the tap are pinned by reading its line count at the instant the mid-turn POST goes out.

It **passes `--model` explicitly**, as `agentpane_pi_smoke.py` has since OW-yehisa, through the create-session route's `model` field.
The first turn's length is a criterion here, so a run that silently answered on whatever `~/.pi/agent/settings.json` happened to name would not be measuring what it reports; the model that answered is still read back off the wire and recorded.

Writes no fixtures.
Same temporary writable state dir and credentials-copied-by-name discipline as the two smoke harnesses.
Costs tokens: one long turn plus the steered reply; `--turn tool` costs one short tool round and about 25 seconds of `sleep` instead of the long turn.

Only `steered_into_running_turn` passes.
`dropped` and `following_turn` are real outcomes it exists to be able to report, and each is a divergence from D16, so each raises; so does `indeterminate`, which is what a run gets when the `queue_update` and `agent_settled` readings disagree or when no `queue_update` names the marker at all — the boundary alone is not allowed to carry a verdict it cannot discriminate.

Verified with: `pi` 0.85.1 on the home server, 2026-09-14, six runs.
What it showed is `docs/MANUAL_TESTING.md`, "A prompt posted mid-turn is steered into Pi's running turn (OW-yuyofu)".
It could not pass again after OW-mofuho retired the `renamed` event it waited for (2026-09-25), until OW-niwusi keyed its waits by the handle the attach reply carried; verified again with `pi` 0.87.1 on the home server, 2026-09-30, one run, in "The live Pi probes follow a session by its handle (OW-niwusi)".
`--turn tool` verified with `pi` 0.87.1 on the home server, 2026-09-30, four runs, with the text turn re-run once beside them, in "Pi's steer waits for the whole tool batch (OW-nufitu)".

## `agentpane_live_support.py`

Not a probe. The machinery both smoke checks share: the HTTP/SSE client, the
process-tree walk, the temporary state dir, and the cleanup criteria. It exists
because the two harnesses differ only in which backend they drive.

## `capture_fixtures.py`

The other two scripts *prove* the protocols work; this one **records** them.
It runs a set of scenarios against each backend and writes every emitted line
to `../fixtures/<backend>/<scenario>.jsonl`, plus a `.meta.json` with
provenance and an event census. Identifying values (model ids, provider names,
hostnames, user agent) are scrubbed to placeholders on the way out, because
fixtures get committed — see `SCRUB_KEYS` in the script. That scrub is keyed on
JSON field names, so it cannot catch operator data a backend echoes into
free-form *content* (a fork capture leaked the home path and skills manifest
this way — see `../fixtures/README.md`, "Scrubbed values"). Any new capturing
probe must grep its generated fixture for operator identifiers before the
fixture is committed; `src/fixture-scrub.test.ts` fails `bun run check` on a
home path, but the username and hostname are still yours to check.

```bash
python3 capture_fixtures.py                                # all
python3 capture_fixtures.py --backend codex --scenario tool-edit
python3 capture_fixtures.py --backend pi --pi-model <ref>  # default is the model AGENTS.md pins
```

Both backends are spawned with an explicit model: Codex as `codex -m gpt-5.6-luna app-server`, recorded as `command` in the `.meta.json`, and Pi as `pi --mode rpc --no-session --model <ref>`, recorded as `model_flag` beside `models_seen`, the `provider/model` its assistant `message_end` events named (OW-yehisa).
Neither metadata field passes through the scrub, so a capture made with a non-public model ref commits that ref.

Read `../fixtures/README.md` for what was captured and what it revealed.

## `fork_probe.py`

Proves: **the 2×2 of `{Pi, Codex} × {rewind, new session}`** — the fork claim
in `DESIGN.md:21` and HANDOFF finding 7, which nothing had ever run (OW-mewiga)
— plus a fifth cell that forks Codex *mid-stream* (OW-gojado). Runs all five
cells live and prints a JSON record saying, for each, whether the operation
exists, what it returned, and what it left on disk:

- **Pi rewind** (`fork`): copy-on-write on 0.84.2 — original file untouched, the
  re-ask spins off a new `parentSession`-linked file, so the abandoned tail
  survives (HANDOFF 43).
  The same cell also forks *mid-stream*, and since OW-sededi it carries the streaming discipline below: forty accumulated `message_update`/`text_delta` events after `agent_start`, re-read at the instant the fork request goes out, a census of every delta kind beside the count, and its own `midstream_result` that the exit status reads.
  Forty rather than the Codex cell's five for the same reason `claude_fork_probe.py` uses forty, and because a reasoning model at `thinkingLevel: "high"` emits its thinking deltas on that same notification — only `text_delta` is counted.
- **Pi new session** (`clone` + `switch_session`): `clone` takes no entry id;
  it copies the whole active branch to a new file and the process is switched
  into it to drive a real turn (HANDOFF 44).
- **Codex new session** (`thread/fork` + `lastTurnId`): new thread id, on-disk
  `forked_from_id`, a real turn driven in the fork (HANDOFF 45).
- **Codex rewind** (`thread/rollback`): recorded as DEPRECATED from the live
  schema rather than fired — "Codex cannot rewind" is the result (HANDOFF 46).
- **Codex mid-stream** (`thread/fork` into a running parent): the only cell that
  reports the *parent* rather than the fork, and the one D15 asked for
  (OW-gojado).
  It confirms the parent is streaming before forking — `turn/started` seen plus `item/agentMessage/delta`s accumulating, never a sleep — and re-reads the buffer once more at the instant the fork request goes out, since the turn can settle in the gap after the threshold is met; it records `result: "unearned"` and exits non-zero if either check fails, because a fork fired at a turn that had already settled measures nothing and fails silently.
  The same gate covers the disk read (OW-wifibe): a parent rollout the cell could not resolve, one that was not on disk to begin with, or one whose already-written lines moved under it all make it "unearned" too, because the finding is what that file gained and a file that was never found gains nothing in the identical way.
  On 0.154.0 the parent survives: deltas keep arriving after the fork, `turn/completed` carries `status: "completed"`, and the whole reply lands in the parent rollout, which the cell sha256s at the fork and again after and then *reads* — the header-only `parent_untouched` check the new-session cell makes could not have told those outcomes apart.
  It also validates the fork itself past the returned id — `thread/read` on it, and its rollout on disk with `forked_from_id` — but drives no turn in it, because the parent is the subject.
  Writes no fixture: nothing here is a protocol shape worth committing, and the cell's own JSON record carries the census of every rollout line the parent gained, which is what a later reader needs.

```bash
python3 fork_probe.py                 # all five cells, write fixtures
python3 fork_probe.py --no-fixtures   # record only
python3 fork_probe.py --backend pi    # one side
```

Writes `../fixtures/{pi,codex}/fork.jsonl` (a forked/cloned session per backend,
with a turn driven inside it). Same writable-state-dir and never-fork-a-corpus-
session discipline as `capture_fixtures.py`; Codex threads are deliberately NOT
ephemeral here because the on-disk residue is the question. New-session cells
end with a completed assistant turn inside the fork, so a returned id alone
cannot pass the check.
Exit non-zero if either new-session cell failed to drive a turn, or if either mid-stream cell's own verdict — `codex_fork_mid_stream.result`, `pi_rewind.midstream_result` — is anything but `measured`.

Since OW-yezeya, after the runs recorded below, it passes the refs `AGENTS.md` pins, by constant: `--model openrouter/deepseek/deepseek-v4.1-flash:high` to the Pi it spawns, and `model: "gpt-5.6-luna"` on every Codex `thread/start` and `turn/start`.
Each cell that drives a turn records that pin in `model_flag` beside the model the backend reported, `model_in_force` from Pi's `get_state` and `model` from Codex's `thread/start` response.

Verified with: `pi` 0.84.2, `codex-cli` 0.147.0; the Pi cells again with
`pi` 0.85.1 on the home server, 2026-09-15 (`docs/MANUAL_TESTING.md`, "Pi's
mid-stream fork, and the forked file on disk, re-measured at the instrument
(OW-gajesu)", and again with the Pi mid-stream gate in place, 2026-09-15,
"Pi's mid-stream fork, measured against text known to have streamed
(OW-sededi)"); the Codex mid-stream cell with
`codex-cli` 0.154.0, on which the rollout no longer writes an
`event_msg`/`agent_message` beside each assistant `response_item` — so
`fork.jsonl`, captured on 0.147.0, is a version behind on line shapes. What that cell showed is `docs/MANUAL_TESTING.md`,
"Forking a Codex thread mid-stream leaves the parent turn running (OW-gojado)".

Two things it handles that the older probes do not, and that will bite anyone
writing their own harness:

- **Writable state dirs.** Both agents need one (`PI_CODING_AGENT_DIR`,
  `CODEX_HOME`), and running under `sbox` does not provide it inside an
  already-sandboxed session. Without it a turn "succeeds" in under a second
  with `stopReason: "error"` and empty content.
- **Blocking requests.** Pi's `extension_ui_request` dialogs and Codex's
  `ServerRequest` approvals both wait for an answer. The harness answers them
  and records that they happened.

## `approval_policy_probe.py`

Proves: **what `approvalPolicy` does to Codex's approval `ServerRequest`s, and
what a forked thread carries** (OW-18). Eight live cells against `codex
app-server`:
the same edit-provoking prompt on `danger-full-access` and on `read-only`, each
with and without `approvalPolicy: "never"`; two `thread/fork` cells that read
`sandbox` and `approvalPolicy` straight off `ThreadForkResponse`; and two that
try to provoke an `item/tool/requestUserInput`.

```bash
python3 approval_policy_probe.py            # all cells, JSON record on stdout
python3 approval_policy_probe.py --timeout 150
```

The `read-only` pair is the control that makes the read-only `never` cell mean
something: without it, "no approval arrived" cannot be told apart from "the
prompt never provoked one". It licenses nothing about the `danger-full-access`
pair, where no approval arose either way.

Each server-initiated request is recorded **with its method and params**,
before being answered, in a list of its own -- so a cell reports which requests
arrived, not merely that some did. `fork_probe.py` also logs each one before
answering, but it answers every server request uniformly and keeps no separate
record.

Writes no fixtures. One temporary writable `CODEX_HOME` for the whole run, with
`auth.json`/`config.toml` copied in by name and never printed -- only the
config's key and table *names* reach the record, so a reader can tell
app-server's defaults from the operator's config. A temporary git workspace per
cell. Both removed on exit. Threads are ephemeral except the fork parents,
which have to materialise on disk for `thread/fork` to load them. Costs tokens:
every cell drives a real model turn.

Verified with: `codex-cli` 0.154.0. What it showed is `docs/MANUAL_TESTING.md`,
"Observed Codex approval policy, and what a fork carries (OW-18)".

## `claude_fork_probe.py`

Proves: **what a mid-stream fork costs a Claude Code parent turn** (OW-japuzo).
Written when `docs/DESIGN.md` D15 was headed "on every backend" and reasoned about Pi and Codex only, so this was the third backend being asked its question; D15 has since been rewritten on what this probe found.
Two cells, both reading the PARENT and never the fork.

```bash
python3 claude_fork_probe.py             # both cells, JSON record on stdout
python3 claude_fork_probe.py --cell kill # one of them
```

`--cell kill` reproduces the kill `claude/adapter.ts` `fork()` performed before OW-razoki deleted `replaceProcess` on 2026-09-13 — `replaceProcess` then `ChildClaudeProcess.kill()`, SIGTERM and a grace and SIGKILL — and asks whether the streaming partial had reached `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` before it landed.
`--cell fork` spawns the fork as a **second** child instead of replacing the first and asks whether the parent turn survives, reading the parent's store both the instant its `result` is seen and again once the writer has quiesced.
That second cell is a probe and not a proposal: it changes nothing in `adapter.ts`, because the point is to establish the behaviour before anyone decides whether the adapter should work that way.

Separate from `fork_probe.py` rather than a third `--backend` in it: that probe's cells are JSON-RPC clients where a fork is one request on a live server, and Claude Code has no RPC surface for a fork at all — it is a process spawn carrying `--fork-session`, over an unmatched NDJSON stream with no request ids.

The streaming discipline comes from `fork_probe.py`'s `codex_fork_mid_stream` cell: `message_start` plus accumulating text deltas before the action, and `result: "unearned"` with a non-zero exit when they are missing.
Two parts were **additions rather than inheritance** when this probe was written, and both have since been carried back into that cell (OW-wifibe).
`still_streaming` re-reads the buffer at the instant of the action, because the threshold being met is not the turn still running when the action lands.
And the "unearned" gate covers the disk read, not just the wire: an unresolved store file, a baseline that does not exist, or a store whose existing lines changed under the cell all fail it.
That last one matters because the headline finding is an *absence* on disk, and a file that was never found produces the identical absence.

The delta threshold is forty rather than the Codex cell's five, and the `kill` cell samples the store at four marks across the reply rather than one.
Both come from runs that went wrong.
A low threshold cannot tell the answer streaming from the coda after it: asked for the integers 1 through 400, haiku called `Bash` and then streamed a short "the counting is complete" summary, so the action landed after the turn had finished and nothing said so.
And one mid-turn sample cannot tell "the store never gains assistant text mid-turn" from "it had not gained any at the one point we looked".

`--tools ""` is there to remove the tool shortcut, and production does not pass it.
What the flag does was checked directly on 2.1.268: with it, `system:init` advertises no built-in tools and the model answers that it has no `Bash` tool available.
It does **not** remove MCP tools, which `init.tools` still lists, so this probe's records are sensitive to the operator's MCP configuration and the cells report their gained-line census by kind partly so a stray `tool_use` would be visible.

The probe spawns `claude` directly rather than through `direnv exec <cwd> sbox`, which is not available on the home server.
It passes by hand the `--permission-mode bypassPermissions` that sbox injects, as 10 of the 11 captures under `resources/fixtures/claude/` do.

Writes no fixtures.
A throwaway git workspace per cell under the temp area, removed on exit, which keeps the probe's sessions in their own `~/.claude/projects/` directory rather than this repo's.
The store files themselves are left where the CLI put them.
Costs tokens: each cell drives two real model turns, one of them long.

Verified with: `claude` 2.1.268 on explicit `--model haiku`.
What it showed is `docs/MANUAL_TESTING.md`, "A mid-stream fork on Claude Code loses the partial reply, but only because agentpane kills the process (OW-japuzo)".

## `codex_unsubscribe_probe.py`

Proves: **`thread/unsubscribe` does not release a Codex thread's writer lock** (OW-voyezi).
Two `codex app-server` processes, one parent thread and one fork of it, and the question that decided OW-voyezi's fix: once a fork borrows its parent's app-server (OW-lajehi), closing one side of the pair no longer kills the child, so something other than the kill has to let go of the closed side's thread.

```bash
python3 codex_unsubscribe_probe.py [--json <path>]
```

It answers, in one run: that the lock exists at all (a second process refused with `-32600`); that unsubscribe answers `{"status": "unsubscribed"}` and the second process is refused exactly as before, on a resumed thread and on a minted one alike; and that the holder can resume a thread it already holds and drive a turn on it, which is the fix that was left.
Shaped after `codex_fork_same_process_probe.py`, whose vehicle it is, down to the temporary `CODEX_HOME` -- safe here, unlike in `fork_attach_probe.py`, because nothing in it consults agentpane's session index.
Costs tokens: three real model turns.

Verified with: `codex-cli` 0.154.0 on the home server, 2026-09-15.
What it showed is `docs/MANUAL_TESTING.md`, "`thread/unsubscribe` does not release a Codex thread's writer lock (OW-voyezi)".

## `session_name_probe.py`

Proves: **all three backends rename an attached session over the wire, mid-session, with no restart** -- the fact D13's write-through decision for names rests on.
One backend per run: `pi --mode rpc` and `set_session_name`; `claude -p` in stream-json and both the `rename_session` control request and a `/rename` user message; `codex app-server` and `thread/name/set`, which is the method's name on 0.154.0 where the vendored bindings still say `setName`.
Each run then reads back where the name landed: Pi's `session_info` lines, Claude's `custom-title` lines, and for Codex `thread/read`, `thread/list`, `session_index.jsonl`, the sqlite `threads.name` column and the rollout file.

```bash
python3 session_name_probe.py --backend pi|claude|codex
```

Sessions are created under a scratch cwd in `/var/tmp` and their store files are left where each CLI put them.
Costs tokens: one real model turn, two on Claude.

Verified with: `pi 0.85.1`, `claude 2.1.270` and `codex-cli 0.154.0` on the home server, 2026-09-15, each on its AGENTS.md pin.
What it showed is `docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire".

`--when pre-turn|mid-turn`, for Claude Code and Codex only, renames instead in the two states that run never tried (OW-kametu): a session in the state agentpane's adapter leaves it in before the first prompt, and one mid-turn, 40 text deltas in.
Each reports the rename's answer against a timeline of the turn and lists the store before and after: Claude's directory for the scratch cwd, and for Codex the rollout, `session_index.jsonl` and the sqlite `threads` row.
`--then-prompt` adds one short turn after a pre-turn rename, and `--skip-rename` makes a Codex pre-turn run the control with no rename.

```bash
python3 session_name_probe.py --backend claude|codex --when pre-turn|mid-turn [--then-prompt] [--skip-rename]
```

These run under a fresh scratch cwd in `/tmp`, and Codex in a temporary `CODEX_HOME` holding copies of `auth.json` and `config.toml`, left on disk.
Costs tokens: none for a pre-turn run, one turn with `--then-prompt` or for a mid-turn run.

Verified with: `claude 2.1.287` and `codex-cli 0.160.0` on the home server, 2026-10-02, each on its AGENTS.md pin.
What it showed is `docs/MANUAL_TESTING.md`, "A rename before the first turn and during one, on Claude Code and Codex (OW-kametu)".

## `codex_fork_history_probe.py`

Proves: **a Codex fork's `history_base` names where its inherited history ends, as an ordinal over the named thread's whole history and a byte offset into its own file** (OW-buligi).
One `codex app-server`, a parent with two turns, a fork of it keeping the first and then taking two turns of its own, and a fork of that fork keeping the fork's first own turn -- the one shape in which the ordinal could have counted either a file's lines or the whole ancestry.

```bash
python3 codex_fork_history_probe.py [--json <path>]
```

For each fork it reports the header's `forked_from_id`, `forked_from_ordinal_exclusive` and `history_base`, what the byte offset lands on in the named rollout, the records either side of the cut, and the turns `thread/read` answers for the fork of a fork.
Shaped after `codex_fork_same_process_probe.py`, whose `AppServer` it imports, down to the temporary `CODEX_HOME`, which it removes on exit.
Costs tokens: four real model turns, each on the AGENTS.md pin.

Verified with: `codex-cli` 0.156.0 on the home server, 2026-09-22.
What it showed is `docs/MANUAL_TESTING.md`, "A Codex fork's rollout names where its inherited history ends (OW-buligi)".

## `codex_history_paging_probe.py`

Proves: **which Codex history loads draw the "Full-history hydration is deprecated for paginated threads" `deprecationNotice`, and that `thread/turns/list` at `itemsView: "full"` pages out the same turns and items for `paginated` and `legacy` threads alike** (OW-kelene).
Every call under test runs in a fresh `codex app-server`, against a thread it starts with two turns and against any rollouts named with `--rollout`, which it copies into its temporary `CODEX_HOME` and never writes back.

```bash
python3 codex_history_paging_probe.py [--rollout ~/.codex/sessions/.../rollout-....jsonl ...] [--json <path>]
```

Imports `AppServer` from `codex_fork_same_process_probe.py`, and removes its temporary `CODEX_HOME` on exit.
Costs tokens: two real model turns, each on the AGENTS.md pin.

Verified with: `codex-cli` 0.156.0 on the home server, 2026-09-24.
What it showed is `docs/MANUAL_TESTING.md`, "Which Codex history loads draw the full-history deprecation, and what replaces them (OW-kelene)".

## `agentpane_codex_history_live.ts`

Proves: **agentpane's own `CodexAdapter` reattaches and forks a thread without drawing that notice**, through the production spawner and `sbox`, and lets the same run be pointed at an older checkout to see what it drew (OW-kelene).
Without `--thread` it first starts a thread and drives two tiny turns; with one it spends no model turn at all.

```bash
CODEX_HOME=<temp home with copied auth.json and config.toml> \
  bun agentpane_codex_history_live.ts --root <checkout> --workspace <git dir> [--thread <id>]
```

Costs tokens: two real model turns on `gpt-5.6-luna` without `--thread`, none with it.

Verified with: `codex-cli` 0.156.0 on the home server, 2026-09-24.
What it showed is the same `docs/MANUAL_TESTING.md` section.

## `agentpane_prompt_events_live.ts`

Proves: **what agentpane's event stream carries for a prompt to an attached Claude Code session**, event by event, and how many snapshots each prompt drew between its send and its turn's end (OW-yirosu).
It starts the server of the checkout `--root` names on a free loopback port, so pointing it at a checkout before a change and after it shows both.
Without `--workspace` it makes a `git init`ed scratch directory, since the home server's `claude` wrapper refuses a directory with no workspace marker.

```bash
bun agentpane_prompt_events_live.ts --root <checkout> [--workspace <git dir>]
```

Costs tokens: two one-word Haiku turns.

Verified with: `claude 2.1.280` on the home server, 2026-09-25.
What it showed is in `docs/MANUAL_TESTING.md`, OW-yirosu.

## `hydrate_window_probe.py`

Proves: **what each backend sends while an adapter reads a live session's history back** (OW-dutute), the window D24's merge-on-hydrate has to reconcile.
`--backend codex` lists a thread's turns mid-stream the way a re-attach does and reports whether the streaming item is listed, and with how much of its text; `--backend pi` forks a streaming turn and resumes the abandoned file, recording every line from each request to the `get_messages` answer.
It reuses `AppServer` from `codex_fork_same_process_probe.py` and `PiSession` from `fork_probe.py`, and spawns `pi` with the pinned `--model`.

`--item` (OW-dirazu) catches a streaming `reasoning`, `commandExecution`, `fileChange` or `plan`, or a running compaction, instead of an `agentMessage`, and reports what `thread/resume`'s `thread.status` read; `--item orphan` kills the app-server mid-turn and has a fresh one resume and list the thread.

```bash
python3 hydrate_window_probe.py --backend codex
python3 hydrate_window_probe.py --backend codex --item commandExecution
python3 hydrate_window_probe.py --backend pi
```

Costs tokens: one long Codex turn on `gpt-5.6-luna` per `--item`, two for `contextCompaction`, or three Pi turns, one of them cut short by the fork.

Verified with: `codex-cli` 0.156.0 and `pi` 0.87.1 on the home server, 2026-09-24; every `--item` with `codex-cli` 0.156.0 there, 2026-09-25.
What it showed is `docs/MANUAL_TESTING.md`, "What each backend says while a live session's history is read back", and "What a Codex listing holds of a running turn, by item kind".

## `emacs_helper_drop_probe.el`

Proves: **a prompt in flight when the Emacs helper's event stream drops keeps its turn-done watch for the helper's teardown**, which ends a turn seen streaming and raises the indicator (OW-zedawo, OW-hiliti).
It drives the real `runHelper` through `emacs_helper_drop_stand_in.ts`, whose `fetch` holds every `POST` open until its signal fires and whose event stream drops 500 ms after it opens.
Its `busy` case waits without yielding until the helper has exited, so the helper's last messages, its sentinel and its teardown are all handled afterwards; its `idle` case lets Emacs handle each as it comes.

```bash
emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
  -l resources/probes/emacs_helper_drop_probe.el \
  --eval '(ert-run-tests-batch-and-exit "agentpane-probe-")'
```

Run from the repository root; `PROBE_RUNS` sets the runs per case (3).
Each case prints `RAISED k of n` and each run's echo-area messages, and passes only when every run raised.
No live model calls, no network beyond the loopback pipe.

Verified with: Emacs 31.1, jsonrpc.el 1.0.29, `bun 1.4.0` on the home server, 2026-09-29; again after OW-nuzoto, 2026-09-30.
What it showed is `docs/MANUAL_TESTING.md`, "A request the helper's teardown aborts gets no reply, and only a refusal abandons a prompt's watch (OW-hiliti)".

## `emacs_helper_server_death_probe.el`

Proves: **a prompt in flight when the agentpane server is killed keeps its turn-done watch for the helper's teardown** (OW-hiliti), though the helper, `bun run src/emacs/main.ts`, may answer the prompt first with the socket's error, a `-32603` carrying no `data`.
The server is `emacs_helper_server_death_server.ts`, a stand-in on a free loopback port that holds the prompt's `POST` open and is SIGKILLed 0.3 s after the prompt goes out.

```bash
emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
  -l resources/probes/emacs_helper_server_death_probe.el \
  --eval '(ert-run-tests-batch-and-exit "agentpane-probe-")'
```

Run from the repository root; `PROBE_RUNS` sets the runs (8).
It prints `RAISED k of n`, with each run's result and the prompt's failure message, and passes only when every run raised.

Verified with: Emacs 31.1, jsonrpc.el 1.0.29, `bun 1.4.0` on the home server, 2026-09-29; again after OW-nuzoto, 2026-09-30.
What it showed is the same `docs/MANUAL_TESTING.md` section.

## Why these live here

A fresh agent building this project has none of the validation conversation's
context. Re-running these is the fastest way to re-establish ground truth
before trusting the `AgentMessage` mapping in `docs/DESIGN.md`.

## `emacs_helper_no_server_probe.py`

Proves: **with no server listening, the Emacs helper answers each `sessions/list` and `sessions/attach` waiting on its first stream open that the server could not be reached, with no `data`, before it exits** (OW-pezelo).
It runs the real helper, `bun run src/emacs/main.ts`, against `http://127.0.0.1:1` with its stdin held open, as Emacs holds it.
The vitest case in `src/emacs/helper.test.ts` holds the helper's rejection but not its race with the input's cancel: under node the replies win that race, and under Bun they lose it to the teardown's abort.
Since OW-nuzoto they are written anyway, the helper being silent only for a failure its abort caused, and the input is cancelled at once, where until then a timer held the cancel back so that the replies won; this probe is the only check that they are still written under Bun.

```bash
python3 resources/probes/emacs_helper_no_server_probe.py
```

Run from the repository root; `PROBE_RUNS` sets the runs (3).
Each run prints the helper's exit and its replies, and the probe prints `ANSWERED k of n` and passes only when every run answered both.
No live model calls, no network beyond loopback.

Verified with: `bun 1.4.0` on the home server, 2026-09-29; again without the timer, 2026-09-30.
What it showed is the `docs/MANUAL_TESTING.md` sections on OW-pezelo and OW-nuzoto.
