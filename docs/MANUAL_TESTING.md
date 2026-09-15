# Manual testing

## What this document is

**The evidence behind the live runs**, and the instructions for reproducing
them. It does not state project status — `WORKSTREAMS.md`'s Status table does
that, and the deck at `docs/work/` holds what is still outstanding. Record a
run's results here; record what the run left undone as a card, filed with
`card new` — never by hand-creating a file under `docs/work/open/`, which card
forbids outright.

Two substantial live-backend runs are recorded below, both on 2026-08-11
(America/New_York): Codex with `codex-cli 0.147.0`, and Pi with `pi 0.84.1`,
each through the production composition. Later sections record narrower
measurements made after that: preview/listing timing, the browser-only OW-47
follow-mode reproduction, and the dispatched-worktree base probe.

Those two backend-backed runs drove the application's REST and SSE interfaces
from a deterministic local harness, against a real agent subprocess, after
fetching the production-built client from the Bun server. Neither of those two
runs was **browser automation**: they make no mouse, keyboard, or DOM
assertions. The browser-automation evidence now in this file is the later OW-47
section, and it is intentionally narrow — a synthetic backend in `e2e/`, not
the backend-backed E2E coverage OW-24 still tracks.

## Reproducible Codex setup

The durable smoke harness asserts every criterion, exits nonzero on failure,
captures its run-scoped PIDs automatically, and cleans up temporary state:

```bash
cd "$(git rev-parse --show-toplevel)"
python3 resources/probes/agentpane_codex_smoke.py \
  --workspace /home/asa0717/src/agentpane
```

It copies credential files by name without printing their contents and leaves
the real `~/.codex` untouched. Do not enable shell tracing while running it.
Run `python3 resources/probes/agentpane_codex_smoke.py --help` for checkout,
workspace, port, credential-source, and build options.

The equivalent manual setup is below for interactive inspection:

```bash
APP_ROOT="$(git rev-parse --show-toplevel)"
WORKSPACE=/home/asa0717/src/agentpane
SMOKE_PORT=44173
CODEX_SMOKE_HOME="$(mktemp -d /var/tmp/agentpane-live-codexhome-XXXXXX)"
SERVER_LOG="$(mktemp /var/tmp/agentpane-live-server-XXXXXX.log)"

for name in auth.json config.toml; do
  if test -f "$HOME/.codex/$name"; then
    install -m 600 "$HOME/.codex/$name" "$CODEX_SMOKE_HOME/$name"
  fi
done

cd "$APP_ROOT"
codex --version
bun run build
CODEX_HOME="$CODEX_SMOKE_HOME" PORT="$SMOKE_PORT" \
  bun run start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
```

Once the server reports that it is listening, confirm the built SPA is being
served as a browser navigation:

```bash
curl --fail --silent --show-error \
  -H 'Accept: text/html' \
  "http://127.0.0.1:$SMOKE_PORT/" \
  | grep '<div id="app"></div>'
```

Open one SSE stream before creating a session and retain it across the turn:

```bash
SSE_LOG="$(mktemp /var/tmp/agentpane-live-sse-XXXXXX.log)"
curl --no-buffer --silent --show-error \
  "http://127.0.0.1:$SMOKE_PORT/api/events" >"$SSE_LOG" &
SSE_PID=$!

CREATE_RESPONSE="$(curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -d "{\"cwd\":\"$WORKSPACE\",\"backend\":\"codex\"}" \
  "http://127.0.0.1:$SMOKE_PORT/api/sessions")"
VIRTUAL_ID="$(jq -r '.ref.id' <<<"$CREATE_RESPONSE")"
ENCODED_VIRTUAL_ID="$(jq -rn --arg value "$VIRTUAL_ID" '$value|@uri')"

ATTACH_RESPONSE="$(curl --fail --silent --show-error \
  "http://127.0.0.1:$SMOKE_PORT/api/sessions/codex/$ENCODED_VIRTUAL_ID")"
CODEX_ID="$(jq -r '.session.ref.id' <<<"$ATTACH_RESPONSE")"
ENCODED_CODEX_ID="$(jq -rn --arg value "$CODEX_ID" '$value|@uri')"
SESSION_URL="http://127.0.0.1:$SMOKE_PORT/api/sessions/codex/$ENCODED_CODEX_ID"
```

Submit a text-only prompt, then inspect the SSE log structurally. Do not assert
on live model wording: look for multiple `upsert` events and a lifecycle
`snapshot` or `status` whose `isStreaming` value returns to `false`.

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -d '{"text":"Do not use tools. Write one sentence of at least 120 words explaining why deterministic tests are useful."}' \
  "$SESSION_URL/prompt"

grep '^data: ' "$SSE_LOG" | sed 's/^data: //' \
  | jq -c 'select(.type == "upsert" or .type == "snapshot" or .type == "status")'
```

To test reconnect, stop only the curl process started above, start a new SSE
request, and verify its opening events include a complete `snapshot`. Compare
the server-scoped process tree before and after; the native `codex app-server`
PID must be unchanged.

```bash
kill "$SSE_PID"
wait "$SSE_PID" 2>/dev/null || true
pstree -ap "$SERVER_PID"

SSE_LOG_2="$(mktemp /var/tmp/agentpane-live-sse-reconnect-XXXXXX.log)"
curl --no-buffer --silent --show-error \
  "http://127.0.0.1:$SMOKE_PORT/api/events" >"$SSE_LOG_2" &
SSE_PID_2=$!
```

For abort, submit work deliberately long enough to remain active, wait for
`isStreaming:true`, then abort and require the following lifecycle state to be
`false`:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -d '{"text":"Do not use tools. Write the integers from 1 through 10000, one per line, and continue until every integer is written."}' \
  "$SESSION_URL/prompt"

curl --fail --silent --show-error -X POST "$SESSION_URL/abort"
```

Finally, send `SIGTERM` only to the server started for this run, wait for it,
and confirm the native Codex PID previously found beneath it no longer exists.
Use the durable harness above when a machine-checked process assertion is
required: it walks `/proc` recursively from its own server PID and never
inspects or kills unrelated Codex processes.

```bash
kill "$SSE_PID_2"
wait "$SSE_PID_2" 2>/dev/null || true
kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
```

After the server and SSE curl have stopped, remove only this run's temporary
files:

```bash
case "$CODEX_SMOKE_HOME" in
  /var/tmp/agentpane-live-codexhome-*) rm -rf -- "$CODEX_SMOKE_HOME" ;;
esac
rm -f -- "$SERVER_LOG" "$SSE_LOG"
test -z "${SSE_LOG_2:-}" || rm -f -- "$SSE_LOG_2"
```

## Observed Codex results

The accepted run used the checked-in harness against the fixed tree, after the
final review's shutdown-race fix and after the harness's own abort, process
scope, and cleanup criteria were tightened. It began at
`2026-08-11T16:00:55.958-04:00` and ended at `2026-08-11T16:01:14.524-04:00`.

| Check | Observed result |
|---|---|
| 1. Create a Codex session for `/home/asa0717/src/agentpane` | Passed at `16:00:57.957-04:00`. Create returned HTTP 201, attach returned HTTP 200, and the virtual id was replaced by a real Codex thread id. |
| 2. Submit text only and observe incremental transcript updates | Passed. Prompt returned HTTP 202. The assistant message at index 1 produced 18 observed upserts with 18 distinct increasing text lengths; the check returns as soon as growth is established, here at 95 characters, and the completed message reached 971. No model wording was asserted or recorded. |
| 3. Observe streaming return to idle | Passed. `isStreaming:true` arrived at `16:00:57.982-04:00`; an authoritative snapshot carried `isStreaming:false` at `16:01:03.616-04:00`. |
| 4. Refresh/reconnect repaint without a duplicate child | Passed at `16:01:12.479-04:00`. A new SSE connection immediately received a two-message snapshot containing the completed 971-character assistant message. Native Codex PID `5921` was the only worker before and after reconnect. |
| 5. Abort a deliberately long prompt | Passed. The second prompt returned HTTP 202 and streamed at `16:01:12.543-04:00`. The session was still reported streaming at the moment of the request; abort was requested at `16:01:12.932-04:00`, returned HTTP 204, and a snapshot recorded idle at `16:01:12.941-04:00` — after the request, not merely after the prompt. The transcript was 971 characters when idle was reported and unchanged 1.5s later. |
| 6. Stop the server without an orphaned app server | Passed. SIGTERM was sent at `16:01:14.491-04:00`; the server exited 0 at `16:01:14.523-04:00`, after run-scoped native Codex PID `5921` had exited. |

Built-client reachability also passed: `/` returned HTTP 200 with the expected
application mount at `16:00:57.471-04:00`.

Cleanup was verified rather than assumed: no run-scoped worker survived, and
the temporary Codex home and server log were both confirmed removed.

The stable long-lived process chain observed before and after reconnect was:

```text
bun (server) 5888
└─ bwrap 5907
   └─ bwrap 5913
      └─ node codex launcher 5914
         └─ native codex app-server 5921
```

The `Popen` wrapper this run launched was PID `5887`. The native worker also
spawned short-lived `git` and `lsb_release` children of its own during the run;
they are descendants of the server tree and disappeared with it.

Production constructs the spawn as `direnv exec <workspace> sbox -- codex
app-server`. `direnv` and the Python `sbox` wrapper exec into the long-lived
processes above, so they did not remain as separate process-tree entries. The
presence of the bwrap namespace and the injected native argument
`--sandbox danger-full-access app-server` confirmed the production sbox path.

Earlier harness-only observations were corrected before any evidence was
accepted: static navigation requires `Accept: text/html`; lifecycle state may
arrive in a `snapshot` rather than only a `status` event; an abort scanned from
the prompt rather than from the request can be satisfied by an idle the abort
did not cause; and `/proc/<pid>/stat` cannot be split on whitespace to find a
parent pid. None of those required an application source change.

Review did produce application hardening ahead of this run. The prompt route
acknowledges only after backend admission succeeds; selection ignores stale
attach completions and stale create responses; Codex disposal awaits process
close with bounded SIGTERM-to-SIGKILL escalation; an adapter still inside
`start()` is now visible to `close()`/`disposeAll()`, so shutdown can no longer
return having orphaned one; and Pi's first-prompt id probe can no longer fail a
turn the backend has already admitted. Every one of those behaviours is covered
by a regression that was observed failing before its fix.

## Observed Pi results

Run with `python3 resources/probes/agentpane_pi_smoke.py --workspace <dir>`,
on `pi 0.84.1`, 2026-08-11 America/New_York. Three of the four checks that were
deferred as manual are now automated; the fourth is partly closed.

| Check | Observed result |
|---|---|
| 1. `direnv -> sbox/bwrap -> pi` startup | Passed. Create returned HTTP 201 and attach HTTP 200, with exactly one Pi agent under the server. The chain is `bun -> bwrap -> bwrap -> pi`; `direnv` and the Python `sbox` wrapper exec into it rather than surviving beside it, the same shape Codex shows. |
| 2. Virtual-id materialization and the `renamed` event | Passed, but **not where it was expected**: Pi names its session file during `start()`, so the rename lands during attach rather than on the first prompt (HANDOFF finding 41). The adopted id is a real `.jsonl` path, the superseded `virtual:` id still resolves, and it resolves to the new ref. A prompt sent through the superseded id returned HTTP 202. |
| 3. Streaming and tool output | Passed at the transport boundary. 16 upserts with 16 distinct increasing lengths, then idle via an authoritative snapshot. With `--tool-check`, a turn produced `thinking` and `toolCall` blocks, and the run reported no approval dialog — a reading that run could not actually make, since the field it rests on was captured before the tool prompt was posted (see "The Pi smoke probe measures the tool turn's own requests" at the end of this file). **Still not verified in a browser against a real backend** — the DOM half of the original check, open as OW-24. |
| 4. Abort and shutdown with no orphan | Passed. The long turn was streaming when abort was requested; abort returned HTTP 204 and idle followed, with the transcript unchanged 1.5s later. SIGTERM to the server exited it 0 with no run-scoped Pi worker remaining. |

Cleanup was verified rather than assumed on every run: no orphaned worker, and
the temporary `PI_CODING_AGENT_DIR` and server log both confirmed removed.

## Observed preview and listing timing (OW-38, OW-23)

Recorded 2026-08-14 against a running production server (`bun run start`,
default port 4173) over a live local corpus of **1001 stored sessions**. These
are REST-only `curl` timings of two read paths that **spawn nothing** — the
on-disk listing and the OW-38 preview route; no agent subprocess was involved.
Not browser automation (OW-24).

Reproduce, with the server already listening:

```bash
curl -s -o /tmp/sessions.json \
  -w '%{time_total}s %{size_download}B\n' \
  http://127.0.0.1:4173/api/sessions
jq '.sessions | length' /tmp/sessions.json
```

| Path | Observed |
|---|---|
| `GET /api/sessions` (1001 sessions) | 0.16–0.24s warm, 429 KB. Matches OW-23's whole-corpus parse (the ~0.28s/973-files figure cited there); real and roughly corpus-linear, but not the cause of any freeze. |
| `GET /…/preview` × the 10 most-recent | 6–14 ms each, size-insensitive: a 36-turn/15 KB Pi transcript previewed in 6.6 ms, a 1-turn/112 B Codex session in 11 ms. |

Two structural findings, both confirming OW-38's design holds at scale:

- The preview reads exactly one file and never walks the corpus — cost is flat
  in transcript size, so a large most-recent session does not make the *fetch*
  slow. Any startup cost from a big transcript is client-side rendering, not the
  route.
- Pi previews (~6 ms) beat Codex (~11–13 ms) consistently: Pi's ref *is* the
  JSONL path (D9, a direct read), while Codex does the `findJsonlFiles`
  readdir walk to match the thread id in the filename.

The perceived "slow session load" reported the same day was **not** either
endpoint: the browser was spinning in OW-39's startup auto-select loop
(`effect_update_depth_exceeded`, OW-41) until Svelte aborted. Neither read path
is implicated.

## Observed follow-mode decay in a real browser (OW-47)

Recorded 2026-08-15 in headless Chromium (Chrome for Testing 151), driven by
the committed harness in `e2e/` — the real `App.svelte` and the real
`controller.ts` against a synthetic `AgentpaneApi`, no backend and no
subprocess. This is the first browser automation in the repo; it is a vehicle
for this one defect and **not** the general E2E coverage OW-24 still tracks.

Reproduce:

```bash
bun run test:browser                       # green
sed -i 's/ overflow-anchor: none;//' src/client/app.css
bun run test:browser                       # red, then: git checkout src/client/app.css
```

| Condition | Observed |
|---|---|
| `.conversation` with `overflow-anchor: none` | All 10 turns of a 40-turn-deep conversation end locked flush at the pane top (≤2px). |
| Same, fix reverted | Fails on the first measured turn: the prompt stops **51px** from the top and stays stranded there. |

The cause is **CSS scroll anchoring**, which none of the item's three candidates
named. The browser repositions `scrollTop` itself to keep a visual anchor
stable as content reflows above the viewport; the agent's instrumented run
measured it under-compensating by ~10px per adjustment. That produces a
`scroll` event the application never performed, and
`handleConversationScroll` correctly cannot tell it from a reader grabbing the
scrollbar — so it clears the anchor and follow disengages mid-turn. Candidate
(a) was the right *shape* (a phantom scroll read as manual) but the wrong
source: not two programmatic scrolls racing one boolean, but the browser
scrolling on its own. A guard against the boolean race was tried and reverted
after it changed no outcome — that race remains real but unproven, now OW-48.

Two findings worth keeping:

- **The transcript has to shrink mid-turn to reproduce this.** `Thinking.svelte`
  holds its `<details>` open only while it is the streaming block, so the moment
  a `toolCall` lands the thinking block collapses and the transcript gets
  shorter. Text-only turns were driven to 200 seeded turns and never
  reproduced it. Any future follow-mode harness needs a turn shape that
  contracts, not just one that grows.
- **jsdom could not have found this**, and still cannot pin it: no layout, no
  scroll anchoring, no real scroll-event timing. `bun run check` does not run
  the browser test (OW-49).

## Observed worktree base for dispatched subagents (OW-58)

Recorded 2026-08-16 from two dispatched worktrees in the same session, each
measured before the agent had edited anything. Not an application test: what is
under test is the harness that cuts the worktree.

Reproduce, first thing in a dispatched worktree:

```bash
git rev-parse HEAD main origin/main origin/HEAD
git rev-list --count HEAD..main
git reflog show "$(git branch --show-current)" | tail -1
```

| Run | Worktree `HEAD` at start | Local `main` | Behind |
|---|---|---|---|
| 1 (landed `9b786a6`) | `9ad0a6d` | `c04f26c` | 19 |
| 2 (this record) | `9ad0a6d` | `cda74e6` | 21 |

`origin/main` and `origin/HEAD` both point at `9ad0a6d`. That is what makes the
base identifiable rather than merely old: run 2 started at the same sha as run
1, though `main` had moved on two commits in between. The branch's own reflog
says it outright — its oldest entry reads `branch: Created from origin/main`,
which is the mechanism stated rather than inferred from the shas.

The base is the **remote tracking ref** — not local `main`, and not the parent
session's HEAD. `AGENTS.md` forbids `git push` unless asked by name, so
`origin/main` is frozen at whatever was last pushed and the gap grows without
bound; it stood at 21 commits at the time of writing. Run 1 paid for it: the
line numbers its prompt cited were off by six against the tree it was given.

This accounts for the two earlier runs recorded as cut behind `main` without
needing the hypothesis that the parent session held a stale HEAD.

The fix landed alongside: `/execute`'s dispatch step now requires the prompt to
tell the subagent to fast-forward to `main` before starting and to report the
sha it started at. Keeping `origin/main` fresh by pushing was rejected — the
never-push rule forbids it.

**Correction, 2026-08-27: this no longer describes how a dispatched tree is
cut here, and the fix it names is retired.** Dispatched worktrees now come from
`card worktree <id>`, which cuts `.worktrees/<id>` on branch `card/<id>` from
the branch the main checkout is on. The base is therefore local `main`, the
staleness gap measured above does not arise, and there is nothing to
fast-forward — the `git merge --ff-only main` step went out with
`.claude/skills/execute/SKILL.md`, deleted in the same change as this note.

The measurement itself stands and is not superseded: it remains a true record
of the Claude Code harness's own worktree cutter (`EnterWorktree`,
`.claude/worktrees/`), which cut from the remote tracking ref when it was
measured; nothing has re-measured it since, and this correction does not claim
to. It is the evidence for why a tree cut that way must be checked before its
base is trusted, should this repo ever be dispatched through that path again.

## Observed manual compaction, Pi and Codex (OW-72)

Captured 2026-08-18 while landing OW-72, through `resources/probes/
capture_fixtures.py --scenario compact`, which primes a context with several
long turns and then drives each backend's manual compaction. These are live
runs against the real CLIs (Codex `codex-cli 0.147.0`, Pi `0.84.2`); the
recorded streams are committed as `resources/fixtures/{codex,pi}/compact.jsonl`.
The Pi figures below are read straight from the committed capture.
The Codex pair originally recorded here was not, and is corrected in the next paragraph.

**Codex** compacts as its own non-steerable turn, triggered by `thread/compact/start`.
Its `thread/tokenUsage/updated` events bracket the compaction: in the committed capture `last.totalTokens` stands at **16304** when the `contextCompaction` item starts and has fallen to **4844** by the time it completes, via 14692 in between.
`total.totalTokens` is cumulative for the thread, not a context size — it runs 9398 → 23009 → 37756 → 54060 → 68752, climbing straight through the compaction — so it can never supply a before/after pair.
This section previously reported that drop as **16802 → 9231 tokens**; neither number appears anywhere in the committed capture and no field reconstructs that pair, so it came from a different run of the same probe and is retired here (OW-kelomi).
The `contextCompaction` item itself carries no summary text and no token figure — only `{ type, id }` — so the marker's body stays empty.
The figure comes off the token-usage stream instead: the reducer samples `last.totalTokens` at the item's `item/started`, because the same stream fires again before the completion and by then reports the shrunk context, and carries it onto the mapped `compactionSummary` as `tokensBefore` (OW-kelomi).
That is the same quantity Pi's `tokensBefore` names, which is the point — two markers on one screen must not give one name to two different things.

**Pi** compacts in response to a `{ type: "compact" }` command. It refuses when
the whole context still fits inside `keepRecentTokens` ("Nothing to compact
(session too small)"; the default is 20000, confirmed against 0.84.2's
`prepareCompaction`), so the capture lowers that knob in the throwaway state
dir before priming. The successful `compaction_end` reported **tokensBefore
17660 → estimatedTokensAfter 4040** (a 77% estimated reduction) along with the
summary text and `firstKeptEntryId`. Pi does not re-emit that summary through
`message_start`/`message_end`, so the reducer builds the `compactionSummary`
message from `compaction_end` itself — verified by the fixture, whose only
events after `compaction_start` are `compaction_end` and the command response.

Pi and Codex therefore differ in what a compaction can show.
Pi has a summary and a real before/after figure, both on the item itself.
Codex has no summary at all, and one figure rather than two: the pre-compaction size, which the item does not carry and the adapter takes from the token-usage stream.
One `Message.svelte` renderer covers both — marker always, summary and token figure only when present.

## Observed fork-from-past, the 2×2 of {Pi, Codex} × {rewind, new session} (OW-mewiga)

Run on the work laptop 2026-08-18, **pi 0.84.2 / codex-cli 0.147.0**, by
`resources/probes/fork_probe.py`. Until this, nothing had ever run a fork on
either backend — `DESIGN.md:21` and HANDOFF finding 7 asserted support from
`rpc.md` and the Codex bindings alone. All four cells ran; the corrections to
finding 7 and `DESIGN.md:21` landed with this work (HANDOFF findings 43–48).
Every run used a throwaway workspace and a throwaway state dir
(`PI_CODING_AGENT_DIR` / `CODEX_HOME`, credentials copied in) — no corpus
session was ever forked, since Pi's on-disk fork behavior was still unproven
when the probe was first built and the throwaway setup made either outcome
safe. Codex
threads were **not** `ephemeral`, because the on-disk residue is the question.
New-session cells end with a completed assistant turn *inside* the fork; rewind
is proven against disk, not against the response (finding 30: a vetoed Pi fork
reports `success: true` with `cancelled: true`).

**Pi, rewind (RPC `fork`).** Exists: returns `{ text: "<forked-from message>",
cancelled: false }`. The surprise is on disk. The adapter docblock
(`pi/process.ts:343`) says `fork` "rewinds the active branch of the SAME
session file in place"; on 0.84.2 it is **copy-on-write** — the active file is
left byte-identical (sha unchanged, its last entry still the abandoned `BETA`
assistant reply), and the post-fork re-ask lands in a **new** file whose header
carries a `parentSession` pointer back. The abandoned tail always survives.
Corroborated by the corpus: 81 of 419 Pi files carry in-file sibling branches
under one parent id (the TUI `/fork` shape). Both routes preserve; neither
destroys. **No destructive-rewind warning is warranted** — the open question the
cell existed to settle (HANDOFF 43). That the adapter still returns an unchanged
`ref` after a fork that moved the active file is the open concern in OW-pifowo.

**Pi, new session (RPC `clone` + `switch_session`).** Exists: `{ cancelled:
false }`. The highest-value unknown answered: **`clone` takes no entry id.** Per
`rpc.md` and confirmed live, it duplicates the *whole active branch* into a new
session at the current position — no per-entry parameter — so branching into a
new session from a chosen point is a composition (`fork` then `clone`, or
`clone` then `switch_session`). The RPC process does **not** auto-switch to the
clone (`get_state` still reports the original), so the probe `switch_session`s
in and drives a real turn: assistant replied `EPSILON`, the clone grew to 9
entries, the original untouched (HANDOFF 44).

**Codex, new session (`thread/fork` with `lastTurnId`).** Exists, wired and
used by the adapter (`codex/adapter.ts:391`). `lastTurnId` (inclusive) returns
a `Thread` with a fresh `id`, `forkedFromId` set to the parent, and its own
`sessionId`; the probe drove a real turn in the fork (assistant replied
`GAMMA`). On disk the new rollout's `session_meta.payload` carries
**`forked_from_id`** (snake_case) — the on-disk mirror of the protocol's
`Thread.forkedFromId` (finding 21). The fork writes nothing to the parent
rollout — this parent was idle, and a mid-stream one keeps writing its own turn
(OW-gojado, below); 21 of 597
corpus files carry `forked_from_id` (HANDOFF 45).

**Codex, rewind (`thread/rollback`) — unavailable, by design.** The method is
still in the 0.147.0 schema, but its `ThreadRollbackParams` description reads
verbatim "DEPRECATED: `thread/rollback` will be removed soon" and its docstring
warns it edits only history without reverting file changes. The probe records
the deprecation from the live schema rather than firing a command slated for
removal, which the adapter deliberately never calls (`codex/adapter.ts:370`).
*Codex cannot rewind in place*; rewind on Codex is expressed as a new-session
fork through an earlier turn — exactly the adapter's design. This is a reported
result, not a probe failure (HANDOFF 46).

Artifacts: the re-runnable probe `resources/probes/fork_probe.py` (`--backend
pi|codex` to run one side, `--no-fixtures` to record without writing them), a
fork fixture per backend at `resources/fixtures/{pi,codex}/fork.jsonl` (both
scrubbed per `resources/fixtures/README.md`), and the two command-surface
deltas as HANDOFF findings 47 (`rpc.md` 32 commands vs `PiCommand`'s 11) and 48
(`ClientRequest.json` 133 methods vs the adapter's ~11).

### Settling the fork's returned ref (OW-pifowo, OW-22)

Run on the work laptop 2026-08-19, **pi 0.84.2 / codex-cli 0.148.0**, by the
re-runnable `resources/probes/fork_probe.py` (the same vehicle as OW-mewiga
above; the `pi_rewind` and `codex_new_session` cells now carry these checks).
This closes the open concern the OW-mewiga cell flagged — what the adapter's
`ref` should be after a fork.

**Pi: the active `sessionFile` moves AT the fork call.** `active_file_moves_at_fork:
true` — the process's active file moves F1→F2 at the `fork` call itself, before
any re-ask, while `original_file_unchanged: true` (copy-on-write, F1 byte-
identical). F2 carries header `parentSession`→F1 (`new_file_parentSession`).
So the adapter must re-adopt the moved file — returning an unchanged `ref` (the
old defect) leaves the server keyed to the abandoned pre-fork branch.

This run also read `moved_file_on_disk_at_fork: false` and concluded F2 materialises only on the next prompt.
**That half did not survive.**
The 2026-08-20 run read `true` at a moved instrument, and the 2026-09-15 home-server run on `pi 0.85.1` read `true` again with the `get_state` back where this run took it — the first round-trip after the `fork`.
F2 was on disk when the fork returned, already carrying the rewound prefix; see "Pi's mid-stream fork, and the forked file on disk, re-measured at the instrument (OW-gajesu)" at the end of this file, and read what follows here under that answer.

**Codex: the forked rollout is flushed to disk before any turn.**
`forked_on_disk_before_turn: true`, `thread_read_forked_before_turn_ok: true`,
`forked_from_id_before_turn` set — Codex mints a new thread the current adapter
is NOT driving and flushes its rollout immediately. The adapter therefore
correctly returns the new thread's ref while leaving its own
`currentRef`/`threadId` on the parent thread; nothing to re-key.

**The conclusion drawn here — "so a fresh attach on the returned ref finds it" —
did not survive `codex-cli` 0.154.0**, where a second app-server process cannot
open a thread the parent's process still holds. See "Forking the most recent
turn and attaching the fork, on all three backends" at the end of this file, and
OW-lajehi. The flush itself still measures true; it is the inference that is
retired.

**Correlator bug fixed in the probe.** `resources/probes/fork_probe.py`'s
`PiSession.response()` scanned `self.raw` from the start on every call, so a
*second* `get_state` returned the first cached response — the `pi_rewind` cell
had survived only because it called `get_state` once, and could not have caught
the active-file move above without this fix. Fixed to capture
`mark = len(self.raw)` before the send and scan only `self.raw[mark:]`, the same
shape `PiSession.turn` already uses.

**Resume proof (one-off, not in the automated probe).** A separate throwaway
run resumed each file with a fresh `pi --mode rpc --session <file>`: resuming F1
(the untouched original) replays the abandoned pre-fork branch — the fork is
LOST — while resuming F2 gives the forked+re-asked branch. This is what makes
re-adopting F2 load-bearing rather than cosmetic. Not folded into
`fork_probe.py` (a resume harness is more than the cell needs); recorded here as
observed.

What a fork with no subsequent prompt costs is therefore a real file, settled against this section's own reading.
The 2026-09-15 run read `moved_file_on_disk_at_fork: true` and `moved_file_messages_at_fork: ALPHA -> ALPHA`, so F2 was in the sessions directory before any prompt, carrying the branch up to the fork point.
`src/server/sessions/walk.ts` readdir-walks that directory to build the picker, so a user who opens an edit, forks, and changes their mind leaves a session there to be listed.
Whether the listing should filter it is a separate question and not settled here.

### Settling second-message semantics and mid-stream fork behavior (OW-yudoni)

Run on the work laptop 2026-08-20, **pi 0.84.2**, by the same re-runnable
`resources/probes/fork_probe.py` vehicle: `python3 resources/probes/fork_probe.py --backend pi --no-fixtures`.
The existing `pi_rewind` cell now primes three turns, forks at the **second**
user message, and then attempts a second fork while a long turn is already
streaming.

**Forking at the second user message is exclusive.** The fork response named
`Say exactly: BETA`, but the proof was read from state, not trusted from that
response: `get_messages` immediately after the fork contained only
`ALPHA -> ALPHA`, with no `BETA`; after the re-ask it contained
`ALPHA -> ALPHA -> DELTA -> DELTA`; and the new branch file on disk carried
the same four messages and no `BETA`. Pi therefore already matches the edit
contract "fork at message N, new branch ends just before it", so
`src/server/adapters/pi/process.ts` needed no index shift.

**Forking while a turn is streaming succeeds, and this run read it as killing that turn.**
The probe started a long prompt, observed `get_state.isStreaming: true`, then sent `fork`.
Pi returned `success: true` with `{ text: "Say exactly: ALPHA", cancelled: false }`, and the `get_state` after that fork reported a different active `sessionFile` and `isStreaming: false`.
`agent_settled` still arrived, but with no assistant text.
That much is what this run earned; the abandonment itself — nothing of the reply in the file the turn was streaming into — was not shown until the 2026-09-15 home-server run on `pi 0.85.1` opened that file, in the OW-gajesu section at the end of this file.

**Two things that run recorded were not evidence for that**, and the cell was changed so a later run could carry the weight this prose claims (OW-gajesu).
It forked at the **first** user message, where the exclusive semantics proven just above empty the new branch whatever became of the turn — so `messageCount: 0` and an empty `get_messages` were tautologies, not corroboration; the cell now forks at the second.
And it read the new branch rather than the file the turn was streaming into, which is where a partial reply would have landed; the cell now reads that file too.
What survives from *this* run is `isStreaming: false` plus a settle with no assistant text.
The rest is supplied by the 2026-09-15 home-server run on `pi 0.85.1`, which forked at the second entry and found the expected two messages, and read the streamed-into file and found the prompt plus an assistant entry with no text — see the OW-gajesu section at the end of this file.

**One older timing claim was contradicted, by a run that had moved the instrument — and the contradiction has since been confirmed at the original instrument.**
The 2026-08-19 OW-pifowo run observed `moved_file_on_disk_at_fork: false`; this one observed `true`, but had inserted a `get_messages` round-trip between the `fork` and the `get_state`, so the two were not measuring at the same moment and the added latency was itself a candidate explanation.
The `get_state` is now back to being the first round-trip after the `fork`, as it was in 2026-08-19, and the 2026-09-15 run at that point read `true` as well.
`false` is retired: it did not survive a run at its own instrument.
That is not a disproof of the latency hypothesis — the CLI version and the machine changed too — and one sample of a race is not an invariant.
The file move itself (`active_file_moves_at_fork: true`) held across all three runs.

### Forking a Codex thread mid-stream leaves the parent turn running (OW-gojado)

Run on the home server 2026-09-11, `codex-cli 0.154.0`, model `gpt-5.6-luna`, by a new `codex_fork_mid_stream` cell in `resources/probes/fork_probe.py`: `python3 resources/probes/fork_probe.py --backend codex --no-fixtures`.
This is the Codex half of the question the OW-yudoni section above answers for Pi, and it is the run D15 named as the one thing that would reopen its decision.
Every earlier Codex fork cell forked an idle thread, so what the parent did during a fork had never been observed at all.

The cell starts a thread the way `codex/adapter.ts` `start()` does — `sandbox: "danger-full-access"`, `approvalPolicy: "never"`, not ephemeral — primes one short turn, then starts a second turn asking for the integers 1 through 400 one per line and fires `thread/fork` into it.
It reports the **parent** thread only; no turn is driven in the fork.

**Streaming was confirmed before the fork, not assumed.**
The cell waits for two signals on the parent's `threadId` and refuses to report a result without both: a `turn/started` notification, and at least five `item/agentMessage/delta` notifications accumulating.
The run saw `turn/started` and five deltas, and no `turn/completed`, before it sent `thread/fork`.
Sleeping instead would have been unable to tell a surviving parent from a fork that landed after the turn had already finished, and that failure mode is silent, so the cell records `result: "unearned"` and the probe exits non-zero when either signal is missing.

**The fork succeeded, and the parent turn ran to completion.**
`thread/fork` returned a new thread id mid-stream without error; `thread/read` on that id succeeded, and its rollout was on disk with `forked_from_id` naming the parent.
No turn was driven in the fork — it is not this cell's subject.
After the fork call the parent emitted a further **300** `item/agentMessage/delta` notifications and then `turn/completed` with `turn.status: "completed"` and `turn.error: null`.
That delta count is a floor: the cell takes its mark after the fork *response* returns, so anything the parent streamed while the request was in flight is not counted.

**A complete reply landed in the parent's rollout on disk after the fork.**
The parent rollout was hashed immediately before the `thread/fork` request went out and again after the parent settled: `93e62f6c…` became `bfb474f6…`, and the file went from 21 lines to 26.
The same residual window applies as above and in the same direction — the seconds spent sending and answering the fork are credited to *after* it, so the disk evidence is not flattered by the gap.
Reading what those five lines contain rather than only that they changed, they are `event_msg`/`item_completed`, a `response_item` `message` with `role: "assistant"`, a `token_usage_record`, `event_msg`/`token_count`, and `event_msg`/`task_complete`.
The assistant line carries 1491 characters beginning `1\n2\n3\n…` and ending `…398\n399\n400` — the whole answer, not a truncated one.
This is the check D15 called for in place of `codex_new_session`'s `parent_untouched`, which reads only the parent header's `forked_from_id` and could not have distinguished these outcomes.

**The rollout's own shape has changed since the committed fixture, which is why one assistant line landed and not two.**
`resources/fixtures/codex/fork.jsonl`, captured on 0.147.0, writes every reply twice: an `event_msg` with `payload.type: "agent_message"` *and* a `response_item` `message` with `role: "assistant"`.
On 0.154.0 the `agent_message` event is gone, replaced by `event_msg`/`item_completed`, and a `token_usage_record` line type appears that the fixture does not have.
So a reply is one assistant-text line now, not two.
Nothing in this section's conclusion turns on that, but the census of gained lines is recorded in the probe's JSON output for every run precisely so the next reader can see a shape change rather than infer one from a count.

**Two things this run does not establish.**
It measured one thread on one model — it shows that a surviving parent is what Codex does here, not that nothing can make it behave otherwise.
And it did not drive a turn inside the fork, so it says nothing about the fork's usability beyond being readable and on disk; `codex_new_session` covers that on an idle parent.

**What it does not need to establish**: the cell forked through the turn *before* the streaming one, and that is not a gap.
`resources/codex-protocol/v2/ThreadForkParams.ts` says of `lastTurnId` that "The referenced turn cannot be in progress", so a fork whose range includes the in-flight turn is not expressible; and `codex/adapter.ts` `fork()` computes `lastTurnId` as the turn *before* the fork point, so agentpane's own mid-stream fork excludes the running turn too.
The cell measured what production does.

So on Codex the parent turn survives a mid-stream `thread/fork` and finishes normally, where on Pi (OW-yudoni) it is abandoned.
The asymmetry D15 assumed on an inference is real and now measured.
D15's abort was, at this run, still a deliberate choice on the Codex side rather than a necessity, and whether to keep it was a separate decision this run did not take.
**Taken since:** OW-ziyobe took it on 2026-09-13 and OW-bakosi landed it the same day — the abort is Pi-only now, and Codex no longer has one.

### A mid-stream fork on Claude Code loses the partial reply, but only because agentpane kills the process (OW-japuzo)

Run on the home server 2026-09-11, `claude 2.1.268`, explicit `--model haiku` resolved by the CLI as `claude-haiku-4-5-20251001`, by a probe written for this: `python3 resources/probes/claude_fork_probe.py`, whose two cells are `--cell kill` and `--cell fork`.
It is a separate file from `fork_probe.py` because that probe's cells are JSON-RPC clients where a fork is one request on a live server, and Claude Code has no RPC surface for a fork at all — a fork there is a process spawn carrying `--fork-session`.

This is the third and last backend to be asked D15's question.
D15 was headed "agentpane stops a streaming turn before forking it, on every backend" at the time of this run, and reasoned about Pi and Codex only; Claude Code did not appear in it once.
The abort was then client-side and backend-agnostic (`src/client/controller.ts` `forkAndSubmit`, the `isStreaming` check), so it had always applied to Claude too, and nothing had ever looked at what it costs there.
**Both retired since:** `aafde65` retitled D15 to "only where the backend abandons that turn anyway, which is Pi" on 2026-09-13, and OW-bakosi made `forkAndSubmit`'s check `ref.backend === "pi" && ...isStreaming` the same day, so the abort is no longer backend-agnostic and no longer reaches Claude at all.

**The command line differs from production, deliberately.**
Production spawns `direnv exec <cwd> sbox -- claude -p ...` (`claude/process.ts` `buildClaudeSpawnCommand`), but `direnv` was not on PATH on the home server at the time of this run, so the probe spawns `claude` directly and passes by hand the `--permission-mode bypassPermissions` that sbox injects — as 10 of the 11 captures under `resources/fixtures/claude/` do, the exception being `permission-request`, which needed a live prompt.
It also passes `--tools ""`, which production does not.
Neither deviation reaches what is measured here: what sbox changes is filesystem reach, and store flush timing, process lifetime and delta arrival do not go through it.
The exact line, both cells, was `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions --tools "" --model haiku --session-id <uuid>`, in a throwaway git repository under the temp area so the probe's sessions land in their own `~/.claude/projects/` directory and never in this repo's.

`--tools ""` is there because the first run of this probe was silently unearned: asked for the integers 1 through 400, haiku called `Bash` and then streamed an 88-character "the counting is complete" coda, so the six text deltas the cell waited for were the end of the turn and the kill landed after it had finished.
Text streaming is the whole subject, so the prompt has to be answered by generating text.
What the flag does was then checked directly rather than inferred from the next run not calling `Bash`, which is also what a coincidence looks like: on 2.1.268, with `--tools ""`, `system:init` advertises no built-in tools and the model replies that it has no `Bash` tool available.
It does **not** remove MCP tools, which `init.tools` still lists, so these records are sensitive to the operator's MCP configuration; no `tool_use` line appears in any gained-line census below.

**Streaming was confirmed before each action, not assumed.**
Each cell waits for a `stream_event`/`message_start` on the parent plus forty accumulating `content_block_delta` text deltas with no `result` yet, re-reads the buffer at the instant of the action to confirm the turn still has not settled, and records `result: "unearned"` with a non-zero exit if any of that is missing.
The re-check was this probe's addition and not inherited: at the time of this run `fork_probe.py`'s `codex_fork_mid_stream` fired `thread/fork` straight off its wait's return and gated only on the wait, and the gap between the two is real there too — closed there on 2026-09-13 by OW-wifibe, which also carried this probe's disk gate across.
The threshold is forty rather than that cell's five for the reason the tool-call run showed: a low threshold cannot tell the answer streaming from the coda after it, and that failure mode is silent.
The gate also covers the **disk** read, because the headline below is an absence on disk and a store file that was never resolved produces the identical absence; an unresolved path, a missing baseline, or a store whose existing lines change under the cell all fail it.

#### 1. The store gains no assistant content at any point during the turn

The `kill` cell reproduces what `claude/adapter.ts` `fork()` did at the time of this run: `replaceProcess` sets `previous.live = false`, rejects the pending controls, and awaits `previous.proc.kill()` before respawning.
That kill is gone as of OW-razoki (2026-09-13) -- `fork()` no longer touches the parent's child -- so this cell now reproduces nothing agentpane does, and stands only as the measurement of what the kill cost.
The cell kills the same way `ChildClaudeProcess.kill()` does — stdin closed, SIGTERM, a two-second grace, SIGKILL — and SIGTERM was enough (exit code 143, no escalation).

It reads the store at four marks across the reply and kills at the last, because one sample cannot tell "the store never gains assistant text mid-turn" from "it had not gained any at the one point we looked".
All four marks landed mid-turn, and the file was **byte-identical at every one of them**:

| mark | deltas | chars streamed | store | sha256 | gained since previous |
| --- | --- | --- | --- | --- | --- |
| 1 | 41 | 230 | 24 lines | `be0b9d83…` | 2 `queue-operation`, 1 `user:text`, 1 `attachment` |
| 2 | 87 | 579 | 24 lines | `be0b9d83…` | nothing |
| 3 | 121 | 851 | 24 lines | `be0b9d83…` | nothing |
| 4 | 160 | 1163 | 24 lines | `be0b9d83…` | nothing |

The four lines gained by the first mark are the prompt going in.
**No assistant content of any kind — not a text block, not a thinking block, not a partial — appeared at any mark**, across 41 to 160 deltas and 230 to 1163 characters, the latter about 78% of the 1491-character reply this prompt eventually produces.
The file had 20 lines and `f7dc849f…` after the priming turn quiesced.
The kill added exactly one more line, a `last-prompt`, for 25 lines, and the immediate and quiesced post-kill reads agree on that, so nothing arrived late from a dying writer either.

Note where the first row's numbers come from: 41 is the first poll past the threshold of forty rather than a chosen value, and both figures are the state at the first of the four marks, three marks *before* the kill rather than at it.

The census does detect assistant text when there is any: in the contaminated first run, where the turn completed around the kill, the same code reported an `assistant:text` line of 109 characters landing in exactly that window.
So the null here is the CLI's behaviour and not an artifact of how the lines are read.

The `fork` cell closes the remaining span in one run.
It reads the parent's store twice — the instant the parent's `result` is seen, and again once the writer has quiesced:

- at the fork (40 deltas): 24 lines, `2f87b565…`
- at `result`: 24 lines, `2f87b565…` — **byte-identical, nothing gained**
- after quiescing: 26 lines, `fbff2821…`, gaining one `assistant:thinking` and one `assistant:text` of 1491 characters

So on 2.1.268 a `claude -p` session's assistant message reaches `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` only at the end of the turn, and strictly *after* the wire has said the turn is over.
Between them the two cells cover the span from 40 deltas to past `result` with no assistant content on disk anywhere in it, in two independent sessions.
**The loss to a kill is therefore total, and it matches Pi's in effect while differing from it in cause.**
On Pi the CLI abandons the turn whatever the client does (OW-yudoni).
On Claude the CLI would have finished it; agentpane kills the process hosting it.

This replaces a weaker claim an earlier draft of this section made from a single mid-turn sample and a cross-run comparison of two sessions that were never measured at the same point.

#### 2. The parent turn survives a fork spawned beside it

The `fork` cell leaves the first child running and spawns the fork as a **second** child: `--resume <parent-id> --resume-session-at <entry-uuid> --fork-session --session-id <uuid>`.
Nothing in `adapter.ts` was changed; this establishes what the CLI permits before anyone decides what the adapter should do with it.

The parent finished normally with a second child alive beside it.
After the fork mark it emitted a further **160** text deltas and then `result` with `subtype: "success"` and `is_error: false`, and its store ended up with the whole 1491-character reply, `1\n2\n3…` through `…398\n399\n400`, durably, in the session agentpane lists.
That count is a floor: the mark is taken as soon as the second `Popen` returns, so deltas the parent streamed while the second process was starting fall into neither number rather than being credited to the parent's post-fork total.

The fork came up as a genuine session rather than a process that merely started.
It adopted the session id it was given — `init.session_id` equal to the uuid passed, about eight seconds after the spawn — answered its own prompt with `BETA` and `result` `subtype: "success"` while the parent was still counting, and has its own 24-line store file.
Two `claude` children with live turns overlapped on the same workspace, one resuming the other's store file mid-write, and neither reported an error.

#### What this means for D15

**Claude sits on Codex's side of the line.**
The parent turn is capable of surviving a fork; what ends it is agentpane's kill, not the CLI.
Pi is the only backend where the loss is forced.

That makes D15's uniformity argument harder rather than easier, in two ways.
Its remaining case is "Pi cannot be brought to match, so the alternative is a permanent split" — and the split is now one backend against two, not one against one.
And the cost of the abort is larger on Claude than the Codex run made it look.
D15 records that on Codex the surviving turn "wrote its whole reply durably into the parent's rollout" and so the tokens are spent either way; on Claude the killed turn writes nothing at all, so agentpane's abort destroyed a reply that would otherwise have landed.
**Spent rather than paid:** that cost is what OW-bakosi removed on 2026-09-13 by making the abort Pi-only, which is the finding of this run acted on rather than a contradiction of it.

**Where the distinction does not survive contact** is the shape of the survival.
Codex survives by construction: one app-server process hosts many threads, `thread/fork` mints a thread beside the parent, and there is nothing to kill.
Claude would survive only by running two processes at once, which is a thing the CLI allows and the adapter did not do at this run.
So "Claude is like Codex" was true of the backend and not yet true of anything agentpane could ship.
**Shippable since:** OW-razoki made the adapter do exactly that on 2026-09-13 — `ClaudeAdapter.fork()` runs nothing and returns the `StartOptions` for a second child, `replaceProcess` is gone, and `SessionManager` parks the recipe in `#pendingForks` until the attach spawns it.

This run takes no decision. `OW-ziyobe` is the card that takes D15's, and it is blocked on this one; the contradiction above is for it to retire.

#### What this run does not establish

It measured one workspace, one model, and one fork point, on two turns each.
It shows that a surviving parent is available on Claude Code, not that nothing can make it behave otherwise.
The store samples begin at 40 deltas, so the first seconds of a turn are unsampled; what they cover is everything from there to past the end.

It also did not fork *into* the streaming turn, and the reason is not the one Codex has.
On Codex `lastTurnId` is **exclusive** of the named turn and the schema forbids naming one in progress, so `codex/adapter.ts` `fork()` computes the turn before the fork point.
On Claude `--resume-session-at` is **inclusive** of the named entry (OW-mayuza), and the exclusion here is just where the probe put its fork point: the last entry of the quiesced priming turn.
Production would name the entry immediately before the long prompt's `user` line, which `listForkPoints` supplies as `previousUuid` — and the census above shows a `queue-operation` line can sit between those two.
The two backends land on the same range for opposite reasons, and the probe's range is production's approximately rather than exactly.

**Settled by OW-razoki (2026-09-13), by not needing an answer.**
`fork()` now mints the fork's session id and the `StartOptions` that spawn it and runs nothing, so the fork gets its own adapter, its own `Ownership` and its own control channel by the path that already attaches a session -- the parent's single child is never displaced and `replaceProcess` is deleted.
The paragraph below sized the alternative that was weighed and rejected, two children under one adapter, and is kept as that record.

**Open at the time of this run, and not designed around here: whether a second concurrent child is cheap in the adapter.**
The CLI permits it; the adapter is written for one child.
`Ownership` is a single nullable field on `ClaudeAdapter` and `replaceProcess` is written as a swap over it; the control channel has one `controlNamespace` and one `pendingControls` map per adapter, which `replaceProcess` rejects wholesale on a fork; and `SessionManager.fork`'s docblock records that Claude "takes Pi's path here" through `#adoptRef`, re-keying the session table because `adapter.ref` changes.
A surviving-parent fork would take Codex's path instead — the adapter's own `ref` unchanged, the returned ref naming a session this adapter is not driving — and something would then have to drive that session.
Whether that is a small change or a real refactor is a question for whoever takes the decision; this run only removes the reason to assume the backend forbids it.

### A fork through agentpane leaves the parent's turn running and answers on its own child (OW-razoki)

Run on the home server 2026-09-13, `claude 2.1.270`, `direnv 2.37.1`, every turn on `--model haiku` (the standing authorization condition), passed as the session's `model` through the API.
This is the run OW-japuzo's section could not be: that one measured a probe's kill against a probe's spawn, and this one drives the real server over the production spawn path.

**Nothing about the command line differs from production.**
`bun run start` on port 4321, driven over the HTTP API with an `/api/events` SSE reader deciding when a turn was genuinely mid-stream.
Each session's workspace was a throwaway `git init` directory under the session scratchpad, so the stores landed in their own `~/.claude/projects/` directories and never in this repo's; all of them were removed afterwards.
The fork's child, read out of `ps` while it was alive, was:

```
claude --permission-mode bypassPermissions -p --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages --model claude-haiku-4-5-20251001 \
  --resume 58cef8cf-b562-491f-b1e0-50e375bec767 \
  --resume-session-at 7c4670f1-4273-4c99-96b8-21022c32d966 \
  --fork-session --session-id 76e81bd6-d5d2-496b-a2f3-86b6e8590dd5
```

which is `buildClaudeSpawnCommand`'s fork shape with sbox's `--permission-mode bypassPermissions` injected, reached through `direnv exec <cwd> sbox --`.

#### 1. The parent finishes its reply, and the reply reaches disk

Every run forked while the parent's second or third turn was streaming, confirmed at the instant of the fork by an `isStreaming: true` status plus several hundred accumulated characters of assistant text, not by a timer.

| fork point | parent text at fork | parent's final reply | store growth after the fork | reply on disk |
|---|---|---|---|---|
| `session-start` | 470 chars | 3702 chars | 7439 bytes | yes |
| a real store entry | 490 chars | 3906 chars | 7491 bytes | yes |
| a real store entry, fork driven concurrently | 496 chars | 8536 chars | 12549 bytes | yes |

The store growth is the whole point: at the moment of the fork the parent's file did not yet carry a byte of that reply, which is OW-japuzo's finding unchanged on 2.1.270.
Under the old `replaceProcess` the kill landed exactly there and all of it was lost.
The `POST .../fork` route returned `201` in under 10ms in every run, because `fork()` now only mints an id and builds `StartOptions`.

#### 2. The fork inherits the parent's truncated history, and only that

Forking at a real store entry rather than `session-start` is what exercises `--resume --resume-session-at --fork-session`, and the two are different code paths in `ClaudeAdapter.start`, so both were run.

The parent was told a codeword on turn 1, answered `second` on turn 2, and was mid-way through a long essay on turn 3 when the fork was taken at the entry preceding turn 2's prompt.
Asked "What is the codeword, and have we discussed bicycles?", the fork answered:

> PLATYPUS, and no, we haven't discussed bicycles.

So the fork carried turn 1 across and carried neither turn 2's cut nor the turn 3 the parent was still streaming — truncation inclusive of the named entry, as OW-mayuza has it, now observed through agentpane rather than through a probe.
The fork's own `~/.claude/projects/<munged-cwd>/<fork-id>.jsonl` exists and is a different file from the parent's, and `GET /api/sessions?cwd=<workspace>` lists both sessions.

#### 3. Two children, two live turns, one workspace

The first attempt to show this counted every process named `claude` and proved nothing: the server had been kept alive across runs, so nine children from earlier sessions were still resident, and one of the things named `claude` on this machine is the Claude Code CLI driving the session doing the measuring.
Counting by the two `--session-id` values under test is the measurement that means something.

With the parent still streaming, the fork was attached and prompted without waiting:

```
parent pid 964  --session-id 58cef8cf-...   parent isStreaming = true, 496 chars in
fork   pid 1030 --session-id 76e81bd6-...   fork   isStreaming = true
```

Both children held live turns at the same instant, on the same workspace, and both turns completed: the parent with 8536 characters written durably, the fork with its answer and its own store.
That is the CLI tolerance OW-japuzo measured with two hand-spawned children, now reached through agentpane's own adapters — one adapter and one `Ownership` each, which is what made it cheap.

**Not established here.**
Nothing was measured about a fork of a fork, about two forks of one parent taken together, or about what happens when the parent's turn fails rather than succeeds.
Nothing was run on Pi or Codex: this section is Claude Code only, and Pi remains the one backend whose fork moves the live process's own file.

## Observed favicon badge across engines, and the limit of headless focus (OW-diyuwu)

Recorded 2026-08-18. Two separate things: what headless Chromium refuses to
give the badge, and a one-off check that Gecko does what Blink does. Neither is
a second Playwright project — `playwright.config.ts` stays Chromium-only,
because a second project doubles the runtime of every browser test to cover one
claim.

**Headless Chromium cannot report a page as unfocused.** Playwright drives the
`chromium-headless-shell` build, which answers `document.hasFocus() === true`
and `visibilityState === "visible"` on every page unconditionally. Four levers
were probed and all four moved neither value:

| Lever | Result |
|---|---|
| A second page in the same context, `bringToFront()` | `hasFocus` true, `visibilityState` visible, on both pages |
| `window.blur()` from page script | unchanged |
| CDP `Emulation.setFocusEmulationEnabled({enabled: false})` | accepted, no effect |
| CDP `Page.setWebLifecycleState({state: "frozen"})` | accepted, no effect |

The full `chromium` build does model focus, but does not launch on this
machine: `chrome_crashpad_handler: --database is required`, then the browser
dumps core. So `e2e/badge.spec.ts` stubs `document.hasFocus` in the harness and
carries the rest of the chain, and the focus decision itself is proven over the
pure reducer in `src/client/favicon.test.ts`.

**Firefox 153.0, one-off, headless, against the same harness.** The static
two-file swap is not a Blink-only trick:

| Claim | Observed in Gecko |
|---|---|
| The module creates the `<link rel="icon">` `harness.html` does not declare | 1 element, `href=/favicon.svg` |
| A turn ending unfocused swaps the href | `/favicon.svg` → `/favicon-badged.svg` |
| Focus returning swaps it back | `/favicon-badged.svg` → `/favicon.svg` |
| `public/favicon-badged.svg` parses in Gecko's SVG decoder | decodes 16x16 |
| Gecko acts on the swap rather than ignoring it | a network request for `/favicon-badged.svg` fires on the change |

Reproduce with `bunx playwright install firefox`, `bunx vite --port 5199`, and
a script that drives `window.harness` the way `e2e/badge.spec.ts` does.

**What is still not observed anywhere: the tab strip itself.** Every engine
above is headless and has no tab strip to repaint. The request Gecko fires on
the swap is the closest proxy available here, not the pixel. Tracked as
OW-yiduso.

## Observed streaming cost before and after `$state.raw` (OW-detepa)

Recorded 2026-08-19 on the home server (Intel i3-4010U, 4 cores), Playwright's
bundled headless Chromium 1.62.1. Both runs are a **production build** of
`e2e/perf.html` — `./node_modules/.bin/vite build --config vite.perf.config.ts`,
then `python3 -m http.server 5199 --directory dist/perf`, then
`PERF_URL=http://127.0.0.1:5199/e2e/perf.html bun e2e/perf-probe.ts`. Not under
`bun run dev`: there Svelte's `get_stack`/`get_error` tracing dominates the
profile and roughly doubles every figure.

Median wall time of one `upsert` event, 60 events per cell, before is `5af4a5e`
and after is the same tree with `view` at `src/client/App.svelte` switched from
`$state` to `$state.raw`:

| Scenario | selected before | selected after | background before | background after |
|---|---|---|---|---|
| short transcript (15 msgs), 2 sessions | 8.90ms | 1.00ms | 7.60ms | 0.20ms |
| long transcript (180 msgs), 2 sessions | 78.00ms | 7.90ms | 74.20ms | 1.70ms |
| long transcript (180 msgs), 400 sessions | 92.60ms | 7.30ms | 91.20ms | 5.50ms |
| short transcript (15 msgs), 400 sessions | 21.10ms | 1.90ms | 22.30ms | 1.60ms |

The DOM-mutation counts the harness collects are unchanged across the swap — 21
for the selected session, **0** for the background one, in every scenario both
before and after. That is the point: the work removed produced no pixels.

**The call counts the jsdom test discriminates on.**
`src/client/App.streaming-cost.test.ts` counts `renderMarkdownWithFences`
through a `vi.mock`/`importOriginal` spy, over ten deltas driven through the
real `reduceServerEvent` and a controller that publishes the way
`controller.ts`'s `publish()` does:

| Assertion | Before | After |
|---|---|---|
| ten deltas for a **non-selected** session, 8-turn selected transcript | 160 | 0 |
| ten deltas for the **selected** session, 8-turn transcript | 171 | 11 |
| ten deltas for the **selected** session, 24-turn transcript | 491 | 11 |

160 is 16 rendered markdown blocks × 10 events, all of it for a session with no
DOM on screen. The second pair is the constancy claim: after the change the
cost of a delta no longer tracks the length of the transcript behind it.

## Observed sidebar sort cost before and after memoising `summaries` (OW-jineli)

Recorded 2026-08-19 on the same machine and the same production-build recipe as
the section above, except that the static server was
`./node_modules/.bin/vite preview --config vite.perf.config.ts --port 5199
--strictPort` (it binds `localhost`, so `PERF_URL` has to say `localhost` rather
than the probe's `127.0.0.1` default). `e2e/perf-probe.ts` now carries that
recipe; it used to give the `bun run dev` one, which is the wrong instrument.

Both sides are on top of OW-detepa's `$state.raw`, so this is what is left after
it. Before is `6f65b16`, after is the same tree with `sortedSummaries` reading a
`summaries` derived instead of `view.state.summaries`. Median wall time of one
`upsert`, 60 events per cell, and because the run-to-run spread at 400 sessions
is wider than the effect in a single run, each cell is the **median of three
full probe runs**:

| Scenario | selected before | selected after | background before | background after |
|---|---|---|---|---|
| short transcript (15 msgs), 2 sessions | 1.00ms | 0.90ms | 0.30ms | 0.20ms |
| long transcript (180 msgs), 2 sessions | 5.30ms | 5.30ms | 1.10ms | 1.40ms |
| long transcript (180 msgs), 400 sessions | 7.80ms | 6.50ms | 3.40ms | 1.90ms |
| short transcript (15 msgs), 400 sessions | 1.90ms | 1.00ms | 1.70ms | 0.70ms |

The 2-session rows are the control and they do not move, which is what a sort of
two elements should cost. The saving is the whole of the corpus-size term: at
400 sessions a background event drops to what a 2-session one costs.

**The call counts the jsdom test discriminates on.**
`src/client/App.sort-cost.test.ts` counts `recency` — now exported from
`src/client/time.ts` so it can be spied on — through the same
`vi.mock`/`importOriginal` vehicle, over 22 `upsert` events (11 deltas each into
two sessions) with 8 summaries listed:

| Assertion | Before | After |
|---|---|---|
| 22 upserts, selected and background | 308 | 0 |
| one publish carrying a genuinely new `summaries` array | 14 | 14 |

308 is 22 events × the 14 calls one sort of 8 summaries costs — a full re-sort
per token, for a list that did not change. The second row is the guard: the
memo must not stop the list re-sorting when it really is re-listed.

## Observed perf-harness cost before and after answering fork points (OW-sibebe)

Recorded 2026-09-13 on the home server (4 cores), `bun 1.3.14`, `@playwright/test 1.62.1`, headless Chromium, on the production-build recipe in `e2e/perf-probe.ts`'s docblock.
Before is `3880ea7`, after is the same tree with `e2e/perf-harness.ts`'s `forkPoints` answering one point per user message of the session the ref names instead of `[]`.

The divergence the card is about, measured directly in the built page rather than inferred: with the harness at `sessions: 2, seedTurns: 5, otherTurns: 5`, `[data-edit]` controls in the selected transcript number **0** before and **5** after -- one per seeded user message, which is what the real app draws.
So every perf figure recorded against this harness since OW-roveze was taken on a transcript one button per user message short.

Median wall time of one `upsert`, 60 events per cell, two full probe runs per side (the spread between the two runs is reported where they differ):

| Scenario | selected before | selected after | background before | background after |
|---|---|---|---|---|
| short transcript (15 msgs), 2 sessions | 0.60ms | 0.70ms | 0.20ms | 0.20ms |
| long transcript (180 msgs), 2 sessions | 3.60-3.70ms | 3.80-3.90ms | 1.40-1.50ms | 1.50ms |
| long transcript (180 msgs), 400 sessions | 4.40-4.70ms | 4.90-5.20ms | 2.80-4.30ms | 3.20-3.40ms |
| short transcript (15 msgs), 400 sessions | 1.30-1.40ms | 1.20-1.30ms | 1.10-1.20ms | 1.10-1.20ms |

`rendered` is 15 and 180 on both sides, as it must be: the fix adds buttons to existing messages, not messages.
The selected-session rows move by 0.1-0.5ms, at or just outside the run-to-run spread the 400-session rows already show; the background rows do not move at all, which is the control -- a background session's events touch no transcript DOM, so its cost cannot depend on how many controls that DOM has.
The honest reading is that the missing controls were costing a streaming delta little or nothing to *update*, and that what the empty answer was really hiding was first-paint and node-count fidelity rather than per-event cost.
That is worth knowing and was not knowable before the measurement: the card assumed the reported figures were a floor, and they are, but a shallow one.

## Observed assistant footer rows before and after merging them (OW-75)

Captured 2026-08-19 from the browser vehicle, not from a backend: `page.goto`
on `e2e/harness.html` at the config's 900×700 viewport, screenshotting the
`.transcript` element. What is on screen is `App.svelte`'s auto-preview of the
harness's stored session — one user turn and one completed assistant turn, both
stamped, which is what `harness.ts`'s `preview()` now serves.

Before, the assistant turn spends two rows: copy/expand on one, the timestamp
and model on the next.

![Assistant footer before OW-75: the buttons on one row, the timestamp and model on the row below](images/OW-75-before.png)

After, one row — facts at the left, buttons at the right, the row a user turn
already had.

![Assistant footer after OW-75: timestamp, model and buttons all on a single row](images/OW-75-after.png)

The captured `.transcript` is **228px** tall before and **203px** after. That
25px is one text line and the gap above it, and it is spent once per assistant
turn, so it compounds down a long transcript.

Both captures came from a throwaway spec under `e2e/`, deleted afterwards
rather than kept: a spec that writes files would write them on every
`bun run test:browser`. To retake them:

```ts
// e2e/shot.spec.ts -- run `SHOT=before playwright test e2e/shot.spec.ts`, then delete
import { test } from "@playwright/test";

test("capture", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.locator("[data-role='assistant']").waitFor();
	await page.locator(".transcript").screenshot({ path: `docs/images/OW-75-${process.env.SHOT}.png` });
});
```

The layout claim itself is asserted, not just pictured: `e2e/footer-row.spec.ts`
measures both boxes and fails if the meta is not centred on the buttons' line.

## Observed Claude Code stream-json surfaces (OW-yilabe)

Run on the home server 2026-08-25, **claude 2.1.238**, every live turn on
`--model haiku` (the owner's authorization condition; every turn came back on
`claude-haiku-4-5-20251001`). Not under sbox — the sbox spawn shape was
verified separately on 2026-08-25 and the protocol is sbox-independent. Every
capture ran with cwd inside a throwaway git repo under `/tmp` (`mktemp -d`,
`git init`, one `notes.txt`), so no project CLAUDE.md loaded and the project's
own session store stayed clean. The raw NDJSON of each scenario is committed
under `resources/fixtures/claude/`; each `.meta.json` carries the exact
invocation. The base invocation for every capture below, with per-scenario
flags appended as noted:

```bash
claude -p --model haiku --input-format stream-json \
  --output-format stream-json --include-partial-messages
```

Input lines are `{"type":"user","message":{"role":"user","content":[{"type":
"text","text":"..."}]}}`; closing stdin after the last message lets the CLI
finish the turn and exit.

| Checklist line | Observed |
|---|---|
| `--verbose` still required? | **Version-dependent.** It was not required on 2.1.238 or 2.1.247, but 2.1.267 rejects the full stream-json-input shape without it (`Error: When using --print, --output-format=stream-json requires --verbose`). The adapter passes it unconditionally. |
| `init` event | First line of every session; contents below. |
| Control channel | Exists on stdin/stdout; envelope and verified subtypes below. |
| `/compact` as a user message | Works; sequence below, fixture `compact.jsonl`. |
| `--resume <id> --fork-session` | New session id, parent untouched, history **copied**, no lineage marker; fixture `fork.jsonl`. |
| Pre-tip fork headless | **Exists** — the spawn-time flag `--resume-session-at`, hidden from `--help`. This row first said "none found"; corrected 2026-08-25 (OW-mayuza), evidence in the pre-tip fork paragraph below, fixture `fork-at-message.jsonl`. |
| Headless `-p` writes the store | **Yes** — every capture left `~/.claude/projects/-tmp-<munged-cwd>/<session-id>.jsonl`, plus a `memory/` dir. OW-votasi's enumeration will see adapter-driven sessions. |
| `--session-id <uuid>` | **Caller picks the id.** A `uuidgen`-style uuid passed in came back verbatim as `init.session_id` and named the store file; fixture `session-id.jsonl`. |
| Permission request shape | Captured under `--permission-mode default --permission-prompt-tool stdio`; shape below, fixture `permission-request.jsonl`. |
| Thinking on Haiku headless | **Haiku emits real thinking blocks headless, unprompted** — even the trivial `text-turn` capture opens with a `thinking` content block (`thinking_delta` + `signature_delta` streaming, 688-char signature). There is no absent-thinking finding to carry; the reducer must handle thinking on every turn. |

**The `init` system event.** The first stream line of every session. The
scrubbed line from `text-turn.jsonl`, with the three long name arrays elided
here (the fixtures carry them verbatim):

```json
{"type":"system","subtype":"init","cwd":"/tmp/ow-yilabe-scratch-2WnWbD",
 "session_id":"919cd270-8997-400d-bc1a-ea9d663f5153",
 "tools":["Task","Bash","Edit","Read","Write","WebFetch","WebSearch",…],
 "mcp_servers":[],"model":"claude-haiku-4-5-20251001",
 "permissionMode":"bypassPermissions","slash_commands":[…],
 "terminal_slash_commands":["doctor","color"],"apiKeySource":"none",
 "claude_code_version":"2.1.238","output_style":"default",
 "agents":["claude","Explore","general-purpose","Plan","statusline-setup"],
 "skills":[…],"plugins":[],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1",
                 "msg_lifecycle_v1"],
 "analytics_disabled":false,"product_feedback_disabled":false,
 "uuid":"…","memory_paths":{"auto":"/example-home/.claude/projects/…/memory/"},
 "fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

So identity reporting gets session id, resolved model id, permission mode, and
the tool list from line one. What `init` does **not** carry is a model *list*
— that lives on the control channel: an `initialize` control request's
response carries `models` (each with `value`, `resolvedModel`, `displayName`,
`description`, `supportsEffort`, `supportedEffortLevels`), plus `commands`,
`agents`, `account` (operator email — a fixture hazard, which is why the
initialize probe is not committed), `current_permission_mode`, `pid`, and
`session_state`.

**The control channel.** Client-to-CLI requests are
`{"type":"control_request","request_id":"<any string>","request":{"subtype":
"...",…}}` on stdin; the CLI answers on stdout with
`{"type":"control_response","response":{"subtype":"success"|"error",
"request_id":"<echoed>",…}}`. An unknown subtype errors by name
(`"Unsupported control request subtype: …"`), which is how the surface was
probed. Verified live (fixtures `interrupt.jsonl`, `control-discovery.jsonl`):

| Subtype | Observed |
|---|---|
| `interrupt` | Stops a streaming turn. Sent after 8 `content_block_delta`s of a count-to-500 turn; reply `{"subtype":"success","request_id":…,"response":{"still_queued":[]}}`, the partial assistant text still flushed, then `result` with subtype `error_during_execution`, `is_error:true`, and process exit 1. |
| `set_model` | Exists mid-session. `{"subtype":"set_model","model":"haiku"}` → success; a bogus model name → `error` "Model \"…\" is not a recognized model id", so success is validated, not blind. The later OW-derewo browser run below selected Haiku through this control and the subsequent turn and footer both reported `claude-haiku-4-5-20251001`. |
| `set_permission_mode` | Exists. `{"subtype":"set_permission_mode","mode":"bypassPermissions"}` → success echoing `{"mode":"bypassPermissions"}`. |
| `initialize` | Exists; response contents above. |
| `rewind`, `fork`, `checkpoint`, `list_checkpoints`, `resume`, `status` | All "Unsupported control request subtype" — probed for a pre-tip fork and found nothing on the control channel. The pre-tip lever turned out to be spawn-time, not a control subtype: `--resume-session-at`, below (2026-08-25, OW-mayuza). |

**Permissions.** Three regimes observed under `--permission-mode default`
(which the `--help` choices list omits — it lists `acceptEdits, auto,
bypassPermissions, manual, dontAsk, plan` — yet the flag value is accepted and
is also what `init` reports when the flag is absent):

- `Bash(date)` **ran with no request and no denial** — surprising; the
  expectation was headless default-mode would either ask or deny. No
  allowlist exists in this operator's settings; the mechanism (presumably the
  2.x auto-approval of safe commands — `claude auto-mode` exists) was not
  identified, only the behavior recorded.
- A write **outside cwd** (`touch /tmp/<file>` from the scratch repo) was
  hard-blocked without asking: a `system`/`permission_denied` event, an
  `is_error` tool_result, and the denial listed in `result.permission_denials`.
- An **in-cwd Edit** with the undocumented `--permission-prompt-tool stdio`
  flag (accepted on 2.1.238; the SDK's lever, absent from `--help` — without
  it the request never appears) produced a real ask on the stream: a CLI-
  initiated `control_request` with subtype `can_use_tool`, `tool_name`,
  `display_name`, `input` (the full Edit input, `old_string`/`new_string`
  included), `description`, `permission_suggestions` (e.g. `{"type":
  "setMode","mode":"acceptEdits","destination":"session"}`), and
  `tool_use_id`. Answered with `{"type":"control_response","response":
  {"subtype":"success","request_id":…,"response":{"behavior":"allow",
  "updatedInput":{…}}}}` — the edit then really ran (the file changed on
  disk). Fixture `permission-request.jsonl`.

**`/compact` as a stream-json user message**, on a session with two turns of
history (fixture `compact.jsonl`): `system`/`status` with `status:
"compacting"`, then `status: null` plus `compact_result: "success"`, a fresh
`init` for the same session id, a `system`/`compact_boundary` event with
`compact_metadata` (`trigger: "manual"`, `pre_tokens: 27614`, `post_tokens:
1333`, `cumulative_dropped_tokens`, `duration_ms`, `preserved_segment`), the
summary arriving as a **user** message ("This session is being continued from
a previous conversation…"), a `<local-command-stdout>Compacted
</local-command-stdout>` user line, and a final `result` with `num_turns: 0`
and an empty `result`. The store file keeps a `system` entry with subtype
`compact_boundary` ("Conversation compacted") plus the summary user message.

**Fork.** `--resume 919cd270-… --fork-session` (fixture `fork.jsonl`) minted
session id `471873f3-…`; the assistant correctly answered what the parent
session's turn had asked ("hello there friend"), proving shared history. On
disk the parent file is untouched and the new file carries a **full copy** of
the parent's user/assistant entries re-stamped with the new `sessionId` —
`grep` finds **zero** references to the parent id in the forked file: no
`parentSession`/`forked_from_id` analogue exists. Lineage is unrecoverable
from the store.

**Pre-tip fork (2026-08-25, OW-mayuza — correcting the original finding).**
This paragraph originally ended "there is no pre-tip fork headless", from
accurate probes that looked in the wrong places: `--resume` takes only a
session id, the control subtypes above all came back unsupported, and
`claude project --help` offers only `purge`. The lever is a spawn-time flag
`.hideHelp()`'d out of `--help` (the `--permission-prompt-tool` pattern),
found by grepping the 2.1.238 bundle after the owner pointed out the VS Code
extension forks at arbitrary points: `--resume-session-at <message id>`.
Verified live on the home server, 2026-08-25, claude 2.1.238, Haiku (fixture
`fork-at-message.jsonl`):

```bash
claude -p --model haiku --input-format stream-json \
  --output-format stream-json --include-partial-messages \
  --permission-mode bypassPermissions \
  --resume 471873f3-… --resume-session-at b56e3a52-… --fork-session
```

- **It works headless**, and the identifier is the store line's `uuid` field
  — the first candidate tried, accepted outright; both a `user` and an
  `assistant` entry uuid were accepted as the cut point.
- **Truncation is inclusive** of the named entry and positional: every entry
  after it in the file is dropped, including the named user message's own
  assistant reply. Pi's fork-at-user-message is **exclusive** (OW-yudoni), so
  the adapter must state both semantics: to fork "before user message X"
  here, name the entry *preceding* X. Cutting at X itself leaves X pending,
  and the fork's first turn answers X together with the new prompt (observed:
  the forked turn re-obeyed the retained "Reply with exactly: hello there
  friend" before answering the new question).
- **The drop is semantic, not cosmetic**: cut at the first user message of a
  two-turn parent and asked to quote every earlier instruction, the forked
  turn saw none — the dropped turn was out of context, not just out of the
  new file.
- **Store**: new session id, new file holding the truncated copy plus the new
  turn, parent file byte-identical across every run (sha256 compared), and
  still no lineage marker in the forked file.
- **`--resume-drops-turn <prompt uuid>`** is the print-mode guard the bundled
  SDK pairs with it. It demands that the discarded range be exactly the
  declared turn, *starting with that turn's user prompt entry*: a mismatched
  uuid — and even the cut turn's own prompt uuid, when cutting at a user
  message, since the range then starts with the assistant reply — refuses
  the resume before any model call (`total_cost_usd: 0`, no store file
  written, exit 1, `result` subtype `error_during_execution` with the error
  "Resume rejected by --resume-drops-turn: resuming at … would discard
  entries not attributable to turn …: range does not start with the declared
  turn prompt; first discarded entry 4 [type=assistant, uuid=…]"). The shape
  it fits is cut-at-previous-assistant: `--resume-session-at <last assistant
  entry of turn N-1> --resume-drops-turn <user prompt uuid of turn N>`
  succeeded and dropped exactly turn N.

**Reducer-relevant stream shape**, from `text-turn.jsonl`/`tool-use.jsonl`:
`assistant` events arrive **once per completed content block**, not once per
message — two `assistant` events in the text turn carried `["thinking"]` then
`["text"]` under the **same** API `message.id`, so the reducer must merge
blocks by `message.id` rather than treat each event as a full message.
Within one logical turn the stream restarts `message_start`/`message_stop`
per API round-trip (three in `tool-use.jsonl`: Bash, then Read+Edit, then the
reply). Tool results come back as `user` events wrapping `tool_result`
blocks correlated by `tool_use_id`; tool inputs stream as `input_json_delta`.
Observed tool inputs: Bash `{command, description}`, Read `{file_path}`, Edit
`{replace_all, file_path, old_string, new_string}` — matching what
`render/tools/args.ts` expects. Also on the stream, new relative to the
mapping-table world: `system`/`thinking_tokens` (estimated-token ticks),
`system`/`status` (`requesting`, `compacting`, null), `rate_limit_event`, and
a terminal `result` event carrying `total_cost_usd`, `usage` (with
`thinking_tokens` detail), `modelUsage`, `num_turns`, `permission_denials`,
and `stop_reason`.

## Claude adapter live run (OW-beripo)

Run on the home server 2026-08-25, **claude 2.1.238**, every live turn on
`--model haiku` (the standing authorization condition). Two spawn-time facts
were settled by zero-/one-turn probes before the adapter's design was frozen,
then a full turn was driven through the running app.

**Spawn-time probes.**

- **`init` does not arrive at spawn.** A spawned `claude -p` stream-json
  process sits silent for 20+ seconds with stdin open and nothing sent; the
  `init` event arrives with the **first turn** (2.6s after the first user
  message in the probe). The control channel, by contrast, is live
  immediately: an `initialize` control_request sent with no turn ever run is
  answered at once. Its response carries `models`, `commands`, `account`,
  `pid`, `session_state` — and **no session id**, so a forked session's id
  cannot be learned without running a turn.
- **`--session-id` combines with `--resume --fork-session`.** One Haiku turn:
  resuming the OW-yilabe text-turn session with `--fork-session --session-id
  <fresh uuid>` came back with `init.session_id` and `result.session_id` both
  equal to the chosen uuid, and the answer ("hello there friend") proved the
  parent's history was carried. This is what lets the adapter mint every
  session id — fresh and forked — at spawn, waiting on nothing.

**The adapter-driven turn**, through the real server (`bun run start`, port
4173): `POST /api/sessions {cwd, backend: "claude", model: "haiku"}` created a
virtual session; `POST .../prompt` ("Use the Read tool to read notes.txt …
then reply with exactly: done") attached and drove it. Observed over the real
`/api/events` SSE stream (35 events, captured):

- a `renamed` event re-keying the virtual id to the adapter-minted uuid
  (`#adoptRef` taking Pi's path), then snapshots for the new ref;
- the local user message as an upsert, then **23 assistant upserts** whose
  joined content grew monotonically — live thinking and text deltas, not a
  single end-of-turn repaint;
- a `toolCall` (Read, `{file_path}`) and its correlated `toolResult` pair,
  the call's `stopReason` mapped `toolUse`, the final message `stop`;
- `isStreaming` true for the duration and false after the `result`;
- the store file written at
  `~/.claude/projects/-tmp-ow-beripo-probe/<minted-uuid>.jsonl`, so the
  adapter-driven session is enumerable (OW-votasi) under the id the adapter
  chose.

**UI level too:** the built client (`bun run build`) served by the same
process was driven in headless Chromium (playwright's chromium, a throwaway
script — deliberately not a committed e2e scenario; OW-24 stands). Selecting
the session rendered the full turn: user bubble, both thinking blocks, the
Read call on the bespoke ReadTool card (the case-insensitive registry match
working against Claude's `Read`), the tool result, the final `done` text, and
the model/token footer.

**Honest scope.** The home server had no `direnv` at the time of this run, so the spawn ran with a
pass-through shim on PATH (`direnv exec <dir> <cmd…>` → `<cmd…>`); everything
downstream was real — sbox ran, jailed the workspace, and injected
`--permission-mode bypassPermissions` itself. Not driven live through the
app: `abort`, `/compact`, and fork — fork mechanics rest on the probes
above, OW-mayuza's live evidence, and the fixture-driven unit tests.

## `--verbose` across Claude Code versions (OW-misoru, OW-bumota, OW-jihete)

Probed live on the home server 2026-08-26 (Haiku, per the OW-yilabe /
OW-beripo authorization), against the home server's installed **claude
2.1.238**. The real invocation shape was run twice over the same one-line
stream-json input, once with `--verbose` and once without. Both exited 0,
both wrote pure JSONL to stdout (every line parses; no human-readable logging
leaked into the stream, which was the failure mode worth fearing), both left
stderr empty, and both produced an identical event sequence — `system/init`,
`system/status`, `rate_limit_event`, `message_start`, a thinking block with
`signature_delta`, `assistant`, a text block, `assistant`, `message_delta`,
`message_stop`, `result/success` — with identical key sets on the `init` and
`result` events. The runs differed only by one `thinking_delta` pair, which
is model variance.

So on 2.1.238 the flag is accepted and inert. That was the whole basis for
the owner's decision (2026-08-26) to pass `--verbose` unconditionally rather
than gate on a detected version: the owner separately reported that on
**2.1.246** the flag is required again under `-p --output-format
stream-json`. That report was unreproduced at the time, because the home
server was pinned at 2.1.238.

### The 2.1.246 requirement does not reproduce on 2.1.247 (2026-08-27, home server, claude 2.1.247, Haiku, OW-bumota)

The home server is no longer pinned: `claude --version` reports `2.1.247
(Claude Code)`, from `~/.local/share/claude/versions/2.1.247`. Every probe
below ran there on Haiku. **Honest scope:** the home server still had no
`direnv` at the time of these runs, and they invoked `claude` directly rather than through
`direnv exec <cwd> sbox --`, so the sandbox layer was not in the path. Where
the adapter relies on sbox to inject `--permission-mode bypassPermissions`,
the probes passed that flag by hand. cwd was `/tmp/ow-bumota` throughout.

**Without `--verbose`, both shapes stream normally.** Plain shape:

```bash
echo hi | claude -p --model haiku --output-format stream-json
```

Exit **0**, stderr **empty** (0 bytes), 12 lines of clean JSONL:
`system/init`, seven `system/thinking_tokens`, `assistant`, `assistant`,
`rate_limit_event`, `result/success` — verbatim result line, keys elided:

```json
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Hi Abhay! Ready to help. What are you working on?","session_id":"4713b81e-2bcd-47f7-86fa-c61a879c4639"}
```

The adapter's full shape, same treatment:

```bash
claude -p --model haiku --input-format stream-json \
  --output-format stream-json --include-partial-messages \
  --permission-mode bypassPermissions < in.jsonl
```

Exit **0**, stderr **empty**, 27 lines of clean JSONL:
`system/init`, `system/status`, `rate_limit_event`,
`stream_event/message_start`, a `thinking` block
(`content_block_start` + five `thinking_delta` + `signature_delta`,
interleaved with `system/thinking_tokens`), `assistant`,
`content_block_stop`, a `text` block, `assistant`, `content_block_stop`,
`message_delta`, `message_stop`, `rate_limit_event`, `result/success` with
`"result":"hello there friend"`. Adding `--verbose` back as the control
changed nothing but thinking-delta count and one stray trailing
`rate_limit_event`; both control runs also exited 0 with empty stderr.

**There is no refusal to observe, because the check is not in the binary.**
`claude --help` on 2.1.247 documents `--verbose` as "Override verbose mode
setting from config" — a config override, not a mode gate. The CLI's
flag-validation table is greppable out of the executable, and it carries
entries such as

```
Error: --input-format=stream-json requires output-format=stream-json.
Error: --input-format=stream-json requires --print.
Error: --include-partial-messages requires --print and --output-format=stream-json.
Error: --forward-subagent-text requires --print and --output-format=stream-json.
```

`strings -n 8 ~/.local/share/claude/versions/2.1.247 | grep '^Error: --' |
grep -ci verbose` returns **0**, as it does for 2.1.238. Nothing in either
build refuses a stream-json print-mode invocation for want of `--verbose`.

**`--verbose` composes with resume, fork, and `--session-id`.** A two-turn
parent was minted with `--session-id`, then forked inclusive of the store
line whose `uuid` is the first turn's final `assistant` entry (the cut-point
identification is OW-mayuza's, above). The forked invocation, run once with
`--verbose` and once without:

```bash
claude -p --model haiku --input-format stream-json \
  --output-format stream-json --verbose --include-partial-messages \
  --permission-mode bypassPermissions \
  --resume 50f3adcf-… --resume-session-at 6bed0c2a-… --fork-session \
  --session-id 3c093256-…
```

Both exited **0** with **empty stderr** and 20 stdout lines, and the two
event sequences are **identical, event for event**: `system/init`,
`system/status`, `message_start`, `content_block_start(thinking)`, three
`thinking_delta`/`thinking_tokens` pairs, `signature_delta`, `assistant`,
`content_block_stop`, `content_block_start(text)`, `text_delta`,
`assistant`, `content_block_stop`, `message_delta`, `message_stop`,
`rate_limit_event`, `result/success`. Every semantic property held in both:
`init.session_id` came back as the caller's `--session-id` uuid verbatim,
`result` was `success` / `is_error: false` / `num_turns: 1`, the fork's store
file held the truncated parent (the second turn's "second turn ok" gone) plus
the new turn, `grep` found **zero** references to the parent id in it, and
the parent store file was byte-identical before and after both runs
(sha256 `deaf393a…` unchanged). `--verbose` is an independent boolean; it
neither perturbs the stream nor interacts with the resume/fork flags.

**Conclusion.** The reported 2.1.246 requirement does not hold on 2.1.247:
a current CLI streams stream-json under `-p` with no `--verbose` at all, in
both the plain and the full adapter shape, and the requirement is narrower
than "`-p --output-format stream-json` needs `--verbose`" — on the evidence
here it is not present in that shape on 2.1.247 at all. This does **not**
falsify the owner's 2.1.246 report; 2.1.246 is not installed on the home
server and was not probed, so the honest reading is that the requirement, if
it existed, was transient and is gone by 2.1.247. No version boundary is
claimed in either direction beyond the two versions actually run here
(2.1.238 and 2.1.247), and neither of those requires the flag.

Those conclusions are historical for 2.1.238 and 2.1.247 rather than a promise about later builds.
The 2.1.267 observation under OW-jihete below confirms that the requirement returned, while the always-present flag kept the adapter compatible without a version branch.

## Observed `updatedAt` freshness at a turn's two boundaries (OW-furinu)

**2026-08-28, home server, `claude --model haiku` (2.1.247), `-p
--output-format stream-json --verbose`.**

OW-furinu fixes the session list's order by emitting `sessions-changed` where
`streamingChanged` is already computed in `SessionManager.#onUpdate` — at both
ends of every turn. The card asked, before that was built, whether the
start-side re-list can actually see a moved `updatedAt`: the field is the
session file's mtime (`src/server/sessions/{pi,codex,claude}.ts` each take it
from `stat.mtime`), and the backend writes that file itself, so a re-list fired
at turn start may read a timestamp from before the turn.

**Method.** A watcher polled the session JSONL's mtime and size while the CLI's
own stream-json events were timestamped on the same clock, so the file's writes
and the turn's announcements could be interleaved. Run against a *resumed*
session, which is the second-and-later turn the defect is about — a first turn
already relists via `markPrompted`.

    [turn2] 4.46s FILE ...jsonl size=15338   (touched, size unchanged -- resume)
    [turn2] 4.72s FILE ...jsonl size=15683   (+345 B: the user message)
    [turn2] 4.77s EVENT system/init
    [turn2] 4.90s FILE ...jsonl size=16883
    [turn2] 6.39s EVENT result/success
    [turn2] 6.41s FILE ...jsonl size=20399   (last write)

**Result: usually yes, but not owed.** The backend appends the user message
about 50 ms *before* it announces the turn, so by the time a start-side re-list
reads the file, mtime has typically already moved. But these are concurrent
writes by two processes with no ordering guarantee between them, and the margin
is tens of milliseconds — a start-side re-list that loses that race reads the
previous turn's timestamp and the row does not rise until the turn ends. A
brand-new session shows the same fact in its starkest form: the file does not
exist at all until roughly 2 s in.

**Which is why the emit is at both boundaries and not only at the start.** The
end-side re-list always reads the turn's last write, so the reorder is
*guaranteed* by the turn's end and merely *likely* at its start. Anyone
tempted to halve the emit should halve it the other way, or reorder on
something other than the backend's mtime.

## Observed the CI browser job gating what `check` cannot (OW-bafeja)

`.github/workflows/ci.yml` gained a `browser` job running `bun run test:browser`
as a sibling of `check`. Proved on PR #2 with a deliberate regression, because a
Playwright job that cannot find its browser fails only on the runner and reading
the YAML settles nothing.

The sabotage inverted OW-56's shrink-correlation clause in
`handleConversationScroll` (`src/client/App.svelte`), so a Chromium bottom clamp
reads as a reader scroll again. It never reached `main`; it lived on
`card/OW-bafeja` and was reverted there.

| run | head | `check` | `browser` |
| --- | --- | --- | --- |
| [33522979724](https://github.com/ark3/agentpane/actions/runs/33522979724) | `1c51bde`, sabotaged | success, 42 s | **failure**, at `Run bun run test:browser` |
| [33524663956](https://github.com/ark3/agentpane/actions/runs/33524663956) | `fcc7c53`, reverted | success, 42 s | success, 95 s |

**The gate is real.** One commit, one runner, `check` green while `browser` went
red. That is the whole claim the job exists to make, and no arrangement of unit
tests can make it.

**The runner reproduced the local run test-for-test.** Four failures — the three
follow-mode specs plus the nav-rail spec — and seven passes, identical to
`bun run test:browser` on the home server, with the same `turn 0 stopped
247.8px from the top` deviation OW-56 recorded when it first found the defect.

**Font metrics did not flake, though they were the thing to watch.**
`e2e/composer-shortcut.spec.ts` and `e2e/footer-row.spec.ts` assert on
glyph-driven layout at 900x700, and `ui-sans-serif` resolves through fontconfig
differently on a bare `ubuntu-latest` than on Manjaro. Both passed on the
runner, red run and green. `--with-deps` installs Playwright's font packages,
which is apparently enough; anyone adding a layout assertion should still treat
this as observed-once, not guaranteed.

**Chromium is downloaded per run and that is fine.** The whole `browser` job is
95 s including `bunx playwright install --with-deps chromium`, against 42 s for
`check`. No `actions/cache` was added; at 11 tests it would buy nothing worth
the staleness.

Reading CI from an agent session needs no credentials: run and per-step
conclusions come from `https://api.github.com/repos/ark3/agentpane/actions/runs`
and `.../runs/<id>/jobs` unauthenticated, because the repo is public. Job *logs*
do not — `/runs/<id>/logs` returns 403 without a token — so a surprising red
still needs a human to paste the output. Unauthenticated calls are capped at 60
per hour per IP, so check on a beat rather than polling.

## Observed browser-owned controls under the dark palette (OW-pofeto)

**2026-09-02, home server, Playwright's headless Chromium 151.0.7922.34, emulated dark system palette.**

The harness was opened before the fix with its real `App.svelte` and stylesheet, then the Workspace and Backend selectors were opened and the attached composer's textarea and overflowing conversation were inspected.

The visible mismatch was in both native select menus: their selected rows used Chromium's saturated light-palette blue with white text against the app's dark popup surface.

The textarea resize handle did not show a visible mismatch, and this Chromium build used overlay scrollbars that were not painted in the captured state.

After `:root` declared the palette in force, both select menus used Chromium's dark-palette selected-row treatment, a pale system blue with dark text, while the app's own token colors were unchanged.

The browser spec emulates light and dark separately and reads `getComputedStyle(document.documentElement).colorScheme`; before the declaration both cases returned `normal`, and afterwards they returned `light` and `dark` respectively.

## Observed the theme control's dark cold load (OW-hilufa)

**2026-09-02, home server, Playwright's headless Chromium 151.0.7922.34, emulated dark system palette.**

The production build was served by `vite preview`, and a CDP screencast captured every painted frame across five fresh browser contexts while ImageMagick read the centre pixel of each frame.

With only the two `data-theme` palette blocks, every run painted a white `rgb(255,255,255)` frame before the dark `--ap-bg-sunken` frame appeared 156–180 ms later.
That is a visible light-theme flash, so the card's fallback applies.

The stylesheet now carries a dark `prefers-color-scheme` block restricted to `:root:not([data-theme])`, duplicating the dark palette only for the interval before `main.ts` resolves system to a concrete attribute.
After that fallback, the same five-run capture contained no white frame: the first application frame was `rgb(16,18,22)`, with some runs preceded only by Chromium's own dark navigation canvas at `rgb(18,18,18)`.

The control itself remains non-persistent.
A fresh page starts at System, `main.ts` writes the resolved `data-theme` before mounting, and the component follows later system changes only while System remains selected.

## Observed model selection through real backend turns (OW-derewo)

**2026-09-08, home server, Claude Code 2.1.265 on Haiku and Codex CLI 0.153.4 on `gpt-5.6-luna`.**

The production client was built with `bun run build` and served on port 4197 with `PATH=/tmp/ow-derewo-bin:$PATH PORT=4197 bun run start`.
The home server still had no `direnv` at the time of this run, so `/tmp/ow-derewo-bin/direnv` was the same pass-through shim used by the earlier adapter run: it consumed `exec <cwd>` and executed the remaining real `sbox -- <agent>` command unchanged.
The owner installed the real `direnv` on 2026-09-13, so this substitution applies to runs before that date only; see `docs/HANDOFF.md`, "Environment gotchas".

A throwaway Playwright script created and attached one empty conversation per backend over the real HTTP server, opened the built UI, clicked each conversation row, selected the required model through the visible `Conversation model` picker, sent one prompt, waited for the real turn to settle, and read both the locked composer label and assistant footer from the rendered DOM.

For Claude, the empty conversation initially reported `null`, so the picker truthfully showed its transient loading option rather than claiming a backend default.
Selecting the `haiku` alias through the picker admitted the next turn; after Claude's init resolved that alias, the locked label and assistant footer both named `claude-haiku-4-5-20251001`.

For Codex, `thread/start` reported `gpt-5.6-luna` before the turn.
Selecting `gpt-5.6-luna` through the picker admitted the next turn; the locked label rendered the model list's `GPT-5.6-Luna` display name and the assistant footer named the exact backend id `gpt-5.6-luna` with medium effort.

Both prompts received their requested exact reply, so these were complete backend turns rather than model-list or control-channel probes.
The observations retire the earlier `set_model` qualification and its Honest scope copy: Claude's successful control request now has a subsequent-turn observation through agentpane itself.

## Observed Claude Code mid-turn prompt handling (OW-jihete)

**2026-09-10, home server, Claude Code 2.1.267 on explicit `--model haiku`, resolved as `claude-haiku-4-5-20251001`.**

One `claude -p` process ran with stream-json in both directions, partial messages, `--verbose`, and `--replay-user-messages` in a throwaway git repository under `/tmp`.
The first attempt omitted `--verbose`; before reading the prompt or starting a turn, 2.1.267 exited with `Error: When using --print, --output-format=stream-json requires --verbose`, so the successful capture includes the flag the adapter already passes.
The first prompt asked for the integers 1 through 600, one per line, to keep the response streaming long enough for a deterministic mid-turn write.
After the first text delta arrived at 3,484 ms, the harness wrote a second user message and a `control_request` with subtype `steer` on the same stdin stream.

The `steer` request returned `Unsupported control request subtype: steer` one millisecond later, while the first turn remained active.
The first answer continued through all 600 integers and its `result` arrived at 11,516 ms, 8,032 ms after the second user line was written.
The CLI did not replay or otherwise acknowledge the second user message until 12,228 ms, 712 ms after that first `result`.
It then answered the marker prompt as a separate second turn, whose `result` arrived at 12,700 ms.

This proves both halves needed by D16: ordinary stdin queues a mid-turn prompt for a subsequent turn, and the control channel has no subtype named `steer` on 2.1.267.
The adapter must therefore reject a mid-turn `submit()` rather than writing it, and `/compact` uses the same active-turn gate so it cannot reopen a queue window.
The scrubbed 340-line stream and its invocation, timing, and event census are `resources/fixtures/claude/mid-turn.jsonl` and `mid-turn.meta.json`.

## Observed Fetch Metadata on cross-site loopback requests (OW-fumegi)

**2026-09-09, headless Chromium.**

A page at `http://localhost:4798` targeted `http://127.0.0.1:4799`.
A cross-site image/no-cors GET omitted `Origin` and carried `Sec-Fetch-Site: cross-site`.
A cross-site POST carried `Origin: http://localhost:4798`.
A typed navigation omitted `Origin` and carried `Sec-Fetch-Site: none`.

## Observed Codex approval policy, and what a fork carries (OW-18)

**2026-09-11, home server, `codex-cli 0.154.0`, `resources/probes/approval_policy_probe.py`.**

Eight cells over stdio, each a fresh `codex app-server` in its own throwaway git workspace holding a one-line `notes.txt`, all sharing one temporary writable `CODEX_HOME`.
The probe records each server-initiated request's method and params before answering it, so a cell reports *which* requests arrived rather than only that some did.
Four cells drove the same prompt: edit `notes.txt` so its only line reads `beta`.

The model was whatever the copied `~/.codex/config.toml` selected; re-running the fork cell against the same config read it back off the `thread/start` response as `gpt-5.6-luna`, and the probe now records `reported_model` so a future run carries its own answer.
That config's key and table names are `model`, `model_reasoning_effort`, a `[projects."…"]` trust entry for a path none of these temp workspaces match, a `[notice.model_migrations]` block, and two `[plugins."…"]` toggles.
It sets no `approval_policy` and no sandbox key, which is what licenses calling the values below app-server's own defaults rather than this operator's configuration.

**Under `sandbox: "danger-full-access"`, no approval request arrived either way.**
The cell with no `approvalPolicy` reported `approvalPolicy: "on-request"` on the `thread/start` response and `sandbox: {"type":"dangerFullAccess"}`; `notes.txt` read `beta` afterwards, and the wire carried no `ServerRequest` at all.
The cell with `approvalPolicy: "never"` reported `"never"`, also ended with `beta`, and likewise carried none.
So under agentpane's own sandbox setting the two policies are indistinguishable on this prompt: the sandbox already grants the write, and `on-request` has nothing to ask about.
That is an absence of occasion, not a demonstration that either lever suppresses anything.

**Under `sandbox: "read-only"`, the policies separate.**
With no `approvalPolicy` the thread reported `"on-request"` and the wire carried one `item/fileChange/requestApproval` — params `threadId`, `turnId`, `itemId`, `startedAtMs`, and null `reason` and `grantRoot`.
The probe accepted it and `notes.txt` read `beta`.
With `approvalPolicy: "never"` the thread reported `"never"`, no `ServerRequest` reached the wire, and `notes.txt` still read `alpha`.
That is the control the read-only `never` cell needed: the same prompt provokes an approval without the policy and none with it, so there `"never"` suppresses the request rather than the prompt failing to provoke one.
It licenses nothing about the `danger-full-access` pair, where no approval arose to be suppressed.

`item/fileChange/requestApproval` is the only approval kind any cell provoked.
Nothing here was measured about `item/commandExecution/requestApproval` or the other approval methods.

What the `read-only` cells show about the effect on the work itself is narrower than "the edit was refused".
In the `never` cell a `commandExecution` item completed, no `fileChange` item did, `notes.txt` was unchanged, and the assistant's text said "I’ll update `notes.txt` so it contains exactly the requested line."
The probe reads final file bytes, completed item types, and the absence of a request; it cannot distinguish the sandbox refusing a tool call from the model never issuing one, and it saw no rollback.
Both `read-only` cells reached `turn/completed`, but that notification's `turn.status` was not read on this run — the probe reported the method's arrival and called it completion.
The probe now reads `turn.status`; a re-run of the fork cell reported `"completed"`, and the four approval cells have no such value on record.

**A fork inherits `approvalPolicy` but not `sandbox`.**
A non-ephemeral parent started as the adapter starts one (`sandbox: "danger-full-access"`, no `approvalPolicy`) reported `dangerFullAccess` and `on-request`.
`thread/fork` against it with only `threadId` and `cwd` returned a different thread id, `approvalPolicy: "on-request"`, and `sandbox: {"type":"workspaceWrite","writableRoots":[],"networkAccess":false,…}`.
Repeating the fork from a parent started with `approvalPolicy: "never"` returned `"never"` on the fork response, so the approval policy is genuinely inherited and the `on-request` in the first fork was the parent's, not a fallback.
The sandbox has no such inheritance: both parents reported `dangerFullAccess` and both bare forks came back `workspaceWrite`, a silent downgrade from what the parent thread was running under.
A fork issued with `sandbox: "danger-full-access"` and `approvalPolicy: "never"` passed explicitly reported exactly those.

**`item/tool/requestUserInput` was not provoked, on either of two attempts.**
Both ran on a `"never"`, `danger-full-access` thread.
The first asked the model to use its tool for asking the user a question before doing anything, and to not proceed without an answer; it replied "I can’t ask that question because the user-input tool is unavailable in the current mode. I won’t proceed or modify `notes.txt`." and stopped without editing the file.
The second named the tool (`request_user_input` / `ask-user`), asked for a two-option question, and declared `experimentalApi: true` in `initialize`; it replied "The question tool is unavailable in the current mode." and again stopped.
Neither turn emitted a tool call of any kind — only `userMessage`, `reasoning`, and `agentMessage` items.
So the question is unsettled rather than answered: the tool is gated by something these runs did not find, and whether `"never"` would suppress it if it were available was never reached.
Nothing here is evidence that `"never"` suppresses it, and nothing here is evidence that it does not.

What this means for agentpane.
Setting `approvalPolicy: "never"` was shown to suppress a `fileChange` approval on a `read-only` thread, against a control.
Under the `danger-full-access` sandbox agentpane actually uses, no approval arose in either policy, so on this prompt the policy changed nothing observable — its value is that it stays correct if that sandbox setting ever narrows, and it was not shown to be doing work today.
The fork finding is the one that changes code: carrying `sandbox` on `thread/fork` is not symmetry for its own sake, it repairs a downgrade to `workspaceWrite` that a fork was silently taking.
See D7a.

## Observed Codex `turn/steer` against a live turn (OW-tifuha)

**2026-09-12, home server, `codex-cli 0.154.0`, `codex app-server` over stdio, model pinned to `gpt-5.6-luna` on the `turn/start` params.**

`resources/probes/codex_turn_probe.py` was extended for this and carries the run: after its original short turn it starts a second turn asking for the integers 1 through 200 one per line, waits until that turn is visibly streaming — it takes the turn id from the first notification that names one, and counts every `*/delta` notification, not agent-message deltas alone — and then sends `turn/steer` with `{ threadId, expectedTurnId, input }`.
Re-run it with `python3 resources/probes/codex_turn_probe.py`; it needs `codex` on PATH and copies `~/.codex/{auth.json,config.toml}` into a writable temp `CODEX_HOME` the way it already did.

**`turn/steer` succeeded.**
Fired after 29 deltas against turn `01a093cb-a92b-7ef3-8ac2-02cadd2bb65e`, the response was a result, not an error, and it named that same turn:

```json
{"id": 5, "result": {"turnId": "01a093cb-a92b-7ef3-8ac2-02cadd2bb65e"}}
```

**The steered text lands inside the running turn; no second turn opens.**
Every notification after the steer carried `turnId` `01a093cb-a92b-7ef3-8ac2-02cadd2bb65e`: an `item/started`/`item/completed` pair for the steered `userMessage`, then a `reasoning` item, then a second `agentMessage` whose completed text was exactly the steer's marker `steered-marker-ow-tifuha`.
Exactly one `turn/completed` arrived for that turn, and its `turn.items` summary held the *steered* answer rather than the enumeration.
Over the whole run the census was two `turn/started` and two `turn/completed` for the two `turn/start` calls — the steer added none.

One caveat on what was *not* shown: the model had already emitted its complete 1-to-200 enumeration and that first `agentMessage` completed before the steered `userMessage` item appeared, so this run does not show a steer cutting an in-flight assistant message short.
It shows the request being accepted mid-turn and its content answered within the same turn, which is what D16 needs.

This is the opposite of Claude Code 2.1.267's answer two sections up, where `steer` is an unsupported control subtype.
Codex's rejection of a mid-turn `submit()` was therefore the adapter's own choice and not a protocol limit; `submit` now sends `turn/steer` when a turn is active.
`compact` keeps its rejection for an unrelated reason: `compact` is one of the two `NonSteerableTurnKind`s (`resources/codex-protocol/v2/NonSteerableTurnKind.ts`), so steering a compaction is protocol-impossible.

## Still unverified

Tracked as work items under `docs/work/open/`, not restated here:
**OW-24** (no browser automation yet of a real backend-backed turn — the `e2e/`
browser UI suite drives the real client against a synthetic `AgentpaneApi` port,
with no server in the loop) and **OW-25** (whether Pi raises approval dialogs
without a trusting `trust.json`).

The application has since been opened by hand in a browser, on 2026-08-12. What
that found is OW-26 through OW-31. A further hand-open on 2026-08-14, after
OW-39 landed, hit the startup freeze recorded as OW-41.

## Observed Codex app-server sandbox default on a bare `thread/start` (OW-pibivi)

**2026-09-12, home server, `codex-cli 0.154.0`, `resources/probes/approval_policy_probe.py`.**

Two cells, added to the probe as its `(d)` question and re-runnable on their own with `python3 resources/probes/approval_policy_probe.py --only d`.
Both start one thread with `{"ephemeral": true, "cwd": <fresh git workspace>}` and **no `sandbox` key and no `approvalPolicy` key**, and read the `thread/start` response.
Neither drives a model turn: the whole answer is on that response, so the pair costs no tokens.
They differ only in how `app-server` itself was spawned — one bare, one carrying the flag sbox injects.

The copied `~/.codex/config.toml`'s key and table names on this run were `model`, `model_reasoning_effort`, a `[projects."…"]` trust entry, a `[notice.model_migrations]` block and two `[plugins."…"]` toggles.
It sets no sandbox key and no `approval_policy`, which is what licenses reading the values below as app-server's own defaults rather than as this operator's configuration.
The model read back off both responses was `gpt-5.6-luna`, from that `model` key.

**A bare `thread/start` reports `readOnly`, and the injected CLI flag does not move it.**
Under `codex app-server` the response reported `sandbox: {"type":"readOnly","networkAccess":false}` and `approvalPolicy: "on-request"`.
Under `codex --sandbox danger-full-access app-server` — the exact invocation sbox produces — the response reported the same two values, byte for byte.
So on 0.154.0 the flag is confirmed ignored by `app-server`, and `read-only` is still that path's default.
The OW-37 measurement on 0.147.0 survives its two version bumps unchanged; the repo was not holding a stale fact here.

**Bare-start and bare-fork defaults genuinely differ, and both were measured on 0.154.0.**
A bare `thread/start` reports `readOnly` (above); a bare `thread/fork` off a `dangerFullAccess` parent reports `workspaceWrite` (OW-18, same CLI version, section above).
These are two per-path defaults, not one fact contradicting itself, and reading them side by side is the only way to see that.
A fork is not falling back to app-server's start default — it is falling back to something else again, and to something *wider* than the start default while still being narrower than its own parent.
Nothing here was measured about `thread/resume`.

What this means for agentpane.
Nothing changes in the code: the adapter already passes `sandbox` explicitly on all three thread-creation paths (D7a), which is correct against either default and against both at once.
What the run buys is that the stated reason for doing so is now true on the installed CLI rather than two versions behind it, and that the `read-only` and `workspaceWrite` numbers standing near each other in `docs/DESIGN.md` are no longer an unacknowledged puzzle.

## Pi arrives on the home server, and what its settings file is worth there (no card)

Run on the home server 2026-09-13, **`pi 0.85.1`** at `~/.local/bin/pi`, installed by the owner that day.
Until this, the repo recorded that the home server had no `pi` at all, and the `work-laptop` label existed mainly to send live Pi evidence to the other machine.
Both runs below were ad-hoc: a short Python driver over `pi --mode rpc --session-dir <throwaway>`, speaking the same LF-framed JSON the `PiSession` class in `resources/probes/fork_probe.py` speaks, not a committed probe.
Nothing was written to the session corpus; both runs used throwaway workspaces under `/var/tmp`, since removed.

**Pi runs here, through the documented throwaway state directory.**
With `PI_CODING_AGENT_DIR` pointed at a fresh directory holding copies of `auth.json`, `models-store.json` and `settings.json` — the workaround `capture_fixtures.py` implements, and the same one the read-only `~/.pi/agent` still forces — one turn ran end to end.
`get_state` answered with a resolved model, the prompt `Say exactly: PONG` reached `agent_settled`, and the assistant message carried `stopReason: "stop"` with the text `PONG` and real usage: 1565 input, 4 output, $0.00024.
That is the positive form of the failure this environment produces when the state directory is wrong, which "succeeds" in under a second with `stopReason: "error"` and empty content.
A session file materialised carrying the version-3 header `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`, which is D9's shape.

**Without that redirection Pi resolves no model at all.**
Driven against the real `~/.pi/agent`, with no `PI_CODING_AGENT_DIR`, the process starts and answers `get_state` — but reports `model: {"id": "unknown", "name": "unknown", "provider": "unknown", "contextWindow": 0}` and `thinkingLevel: "off"`.
`pi --help` names the cause on stderr: `Invalid settings file /home/ark3/.pi/agent/settings.json: EROFS: read-only file system, mkdir '/home/ark3/.pi/agent/settings.json.lock'`.
Pi takes a lock merely to *read* its settings, exactly as `docs/HANDOFF.md` records it doing for the credential store, and the sandbox mounts that directory read-only.
No turn was driven from that state, so what such a turn does is unmeasured; the model resolution is the finding.
This is why `AGENTS.md` pins Pi with a flag rather than by pointing at `settings.json`: on this machine, today, that file reaches Pi only when it has been copied somewhere writable first.

**The model the pin names was read off a live turn, not off the file.**
The owner set `defaultProvider: "openrouter"` and `defaultModel: "deepseek/deepseek-v4.1-flash"` in `~/.pi/agent/settings.json` at 22:43 local, with `modelThinkingLevels` mapping `openrouter/deepseek/deepseek-v4.1-flash` to `high`.
The turn above, run after that edit with the file copied in, reported `deepseek/deepseek-v4.1-flash` on the `message_end` and `thinkingLevel: "high"` on `get_state` — so the thinking-level entry does apply to the selected model.
The catalogue entry for it gives a 1048576-token context window, `maxTokens` 384000, and $0.15/$0.60 per Mtok in/out against Kimi K2.6's $0.95/$4.00.
Its `thinkingLevelMap` is sparse: only `off`, `high` and `xhigh` map to real values, while `minimal`, `low`, `medium` and `max` are `null`, so `high` is the bottom of this model's usable reasoning range and `medium` does not exist on it.

An earlier turn the same evening, at 22:40 — three minutes before that settings edit — reported `moonshotai/kimi-k2.6` and was billed at Kimi's rates.
Both readings are correct for their moment, which is the only reason this paragraph is here: a model read off `get_state` is a reading of a mutable file, and it goes stale as soon as the owner edits it.

What this leaves open.
`resources/probes/agentpane_pi_smoke.py` drives Pi through the built server and had not been run on this machine when this section was written; nothing here exercised the server, the adapter, or a fork.
It has since — see "The Pi smoke probe runs on the home server, end to end through the built server" (OW-moradi), run later the same evening.
Whether the read-only `~/.pi/agent` survives the next sandbox restart is unmeasured and expected to change — the owner intends to grant write access, and when that lands the `docs/HANDOFF.md` gotcha and the `AGENTS.md` note above both want re-measuring rather than editing from memory.

## The sandbox restart makes the backend state directories writable (OW-vowire)

Run on the home server 2026-09-13, later the same evening as the section above, after the owner restarted the sandbox.
That section measured the opposite condition hours earlier, and both readings stand for their moment.

**The sandbox is still on; three directories inside it are not read-only any more.**
`$HOME` itself still refuses a write, which is the test `docs/HANDOFF.md` gives for whether the sandbox is running at all, so it is.
Writable now: `~/.pi/agent`, `~/.codex`, `~/.claude`, alongside `/tmp` and the repo tree.
`~/src` does not exist on this machine.

**Pi resolves its configured model with no redirection, and runs a turn.**
`pi --mode rpc` against the real `~/.pi/agent`, with `--session-dir` pointed at a throwaway so the corpus stays clean, answered `get_state` with `deepseek/deepseek-v4.1-flash`, provider `openrouter`, `thinkingLevel: "high"` — the values in `settings.json`, which Pi could not read at all a few hours earlier.
The prompt `Say exactly: PONG` settled with `stopReason: "stop"`, text `PONG`, 1563 in / 4 out, $0.00024, and stderr was empty: the `Invalid settings file ... EROFS` warning is gone.
`pi --version` no longer prints it either.

**The same holds through `sbox`, which is the shape a real spawn takes.**
`sbox -- pi --mode rpc`, run from the repo root so sbox can find its workspace, reported the same model and thinking level.
Only `get_state` was asked there; no turn was driven through sbox.
sbox requires a workspace it can identify — from `/tmp` it refuses with a marker-file and git-root diagnostic — so a probe that spawns it must set `cwd` to the repo.

**Codex's sqlite failure no longer reproduces.**
`codex app-server` with `/dev/null` on stdin exits 0 with empty stdout and empty stderr on `codex-cli 0.154.0`.
Before the restart this path printed `failed to initialize sqlite state runtime`.
That is the whole of what was checked: no thread was started and no turn was driven, so this says the state runtime initializes, and nothing more.

What this closes and what it leaves.
The three passages OW-vowire named — the `docs/HANDOFF.md` state-directory gotcha, its neighbouring sbox-profiles sentence, and the Pi sentence in `AGENTS.md`'s model pin — are reconciled with these readings in the same change, each keeping the date it was measured on.
The model pin stays a flag on all three CLIs: the pre-restart reading is exactly the failure the flag exists to survive, and a readable settings file is still a mutable one.
The throwaway `PI_CODING_AGENT_DIR` and `CODEX_HOME` keep their other purpose — keeping a probe off the real session corpus and credentials — which is why `fork_probe.py` should not drop them.

## The Pi smoke probe runs on the home server, end to end through the built server (OW-moradi)

Run on the home server 2026-09-13, **`pi 0.85.1`**, at commit `967b319`, by `python3 resources/probes/agentpane_pi_smoke.py` — the committed harness, unmodified, twice: once bare and once with `--tool-check`.
Both runs reported `"result": "pass"` with every check inside them passing, and both exited 0.
The client was rebuilt rather than reused (`build.returncode: 0`, no `--skip-build`), so the commit named above is the code that served the run, and `built_client` answered HTTP 200 with `has_app_mount: true` in both.
The bare run took 16 seconds wall clock (23:12:24.002 to 23:12:39.917 local, `-04:00`), the `--tool-check` run 19 seconds.

This is the first time anything has driven Pi through agentpane's own server **on this machine**.
It is not the first time anywhere: `docs/HANDOFF.md` findings 39–42 came out of the first execution of the production chain, on the work laptop, against `pi 0.84.1`.
What the two ad-hoc runs in "Pi arrives on the home server" above did, earlier the same evening, was drive `pi --mode rpc` directly; the OW-vowire section between them added a `sbox -- pi --mode rpc` invocation, which is most of the spawn chain but still no `direnv`, no server, no adapter and no abort.

**The production spawn chain starts an agent, and `bwrap` is in it — finding 39 reproduces here on 0.85.1.**
`buildPiSpawnCommand` asks for `direnv exec <cwd> sbox -- pi --mode rpc` (`src/server/adapters/pi/spawn.ts`), and the process tree under the server was `bun → bwrap → bwrap → pi` in both runs.
`direnv` and `sbox` leave no process of their own — they `exec` away, which is precisely the property the "whether killing the spawned process actually stops the agent" answer in `docs/DESIGN.md` rests on — and the probe walks every descendant of the server, so a survivor would have shown.
Neither `direnv` nor `sbox` carries a version here; `sbox` is a local script the owner edits, so this is a reading of whatever it was that evening.
Exactly one Pi descendant was found each time, reporting `comm=pi` with a command line of exactly `pi`: finding 40's `process.title` overwrite still holds on 0.85.1, so the `node` fallback matcher was again not exercised.

**The rename lands during attach, as finding 41 recorded on 0.84.1.**
`renamed_during: "attach"` in both runs, with `still_virtual_after_attach: false`.
D9 says a `virtual` session has no JSONL path until its first prompt writes one, and the rename beating the first prompt is the thing finding 41 is about; what permits either ordering is the adapter's own contract, which promises `ref` is unstable at two points rather than that it moves at exactly one.
Create and attach returned `[201, 200]`; the adopted id was a `.jsonl` path; the superseded `virtual:` id kept resolving (HTTP 200) and resolved to the new ref; a prompt posted through the superseded id was accepted with 202.

**Streaming, idle and abort all behave, far faster than the probe's timeouts assume.**
The bare run's first turn streamed in 3 incremental updates (27 → 67 characters) and returned to idle 5.0s after `streaming=true`.
The abort was issued against a confirmed-streaming turn at 23:12:38.366 and the turn reported idle at 23:12:38.382 — **16 ms**, the one genuine request-to-event measurement in the run — with the longest assistant message at 472 characters both when idle and 1.5s later, so nothing kept arriving after the abort.
SIGTERM to the server was answered in 32 ms with `returncode: 0`, `launched_pi_worker_pids: [295]` and `remaining_worker_pids: []`; cleanup removed the temporary state home and the server log and reported no orphan.
Waits budgeted at 60, 90, 120 and 180 seconds all resolved within seconds.

**A shell tool call reaches the wire with no dialog request beside it — but this run cannot add to finding 42.**
The `--tool-check` run saw a `toolCall` block at 23:13:06.302, in a message whose blocks were `["thinking", "toolCall"]`.
That is a tool call reaching the client, not an executed command: no `toolResult` and no completion of that turn is recorded either here or in the probe's evidence.
`agent_requests_seen` was the empty list in both runs, and in the `--tool-check` run that field was worthless: the probe as it stood assigned it once, immediately after the *first* turn went idle and before the tool prompt was ever posted, so it was captured before the tool turn existed.
Finding 42 rested on the same field with the same ordering; OW-lapuye scoped the field to each turn's window and measured it, and the finding now cites that run instead (see "The Pi smoke probe measures the tool turn's own requests" at the end of this file).
Two limits held whichever way that was repaired, and both survive the repair.
`agent_requests_seen` can only ever see an `extension_ui_request` carrying a dialog method — that is the Pi adapter's sole source of a `request` event (`src/server/adapters/pi/reducer.ts`) — so an approval delivered by any other mechanism is invisible to it by construction.
And the probe's own comment beside that field, not `docs/DESIGN.md`, is what frames this as "whether these fire at all under the sandbox is an open question (D2a)"; D2a itself is written about Codex's `ServerRequest`, and that phrase is not in it.

**Two of the five files the probe copies do not exist here, including `trust.json`.**
`copied_credential_files` was `["auth.json", "models-store.json", "settings.json"]`; `models.json` and `trust.json` are simply absent from `~/.pi/agent` on this machine.
The `PI_STATE_FILES` comment calls that tuple "enough for a turn", and three of the five were.
This matters for finding 42, which qualifies itself on that file either way — it said "the harness copies `trust.json` into its temporary state dir" when these runs were made, and after OW-lapuye's rewrite says "the home server has no `trust.json` for the harness to copy": here it copied none, and both runs' first turns — the window `agent_requests_seen` does validly cover — still raised no dialog.
The throwaway `PI_CODING_AGENT_DIR` is no longer forced by a read-only `~/.pi/agent` (see the section above), but the probe still sets one, and out of band after both runs `~/.pi/agent/sessions/` held only a JSONL predating them.

What this leaves open.
The evidence blob for *these two runs* records `pi --version` and never records which model answered: the probe sent no `--model`, so Pi resolved its own default out of the `settings.json` copied into the throwaway state home.
That file was measured one section above, twice that same evening, selecting `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"`, and it was not edited between those readings and these runs — so the model is knowable with confidence for them, by inference rather than from the blob.
The probe has since been taught to read it off the wire (see "The Pi smoke probe names the model that answered" below, OW-guvojo), so a run at `1c749a8` or later does record it and this gap is closed for future runs, not retroactively for these.
It is also the reason these runs sit outside `AGENTS.md`'s model pin without violating it: nothing passed `--model`, and the settings file happened to name the pinned model anyway.
The `--tool-check` run's abort phase is not clean evidence either: the probe as it stood at `967b319` posted the long prompt immediately after the `toolCall` block arrived, without waiting for that turn to reach idle, so what it aborted there may have been the tool turn — the bare run's abort is the one to cite from these two runs.
OW-hahohi fixed that and the probe now asserts the session is idle before posting; see "The Pi smoke probe's abort is now provably aimed at the long turn" at the end of this file.
The other half of that card stands as a limit rather than a fix: the long prompt asks for the integers 1 through 10000 and the bare run's transcript stood at 472 characters when the abort landed, so the check exercises far less buffered output than its prompt implies, and the prompt was left as written for the reasons that section records.

## The Pi smoke probe names the model that answered (OW-guvojo)

Run on the home server 2026-09-13, **`pi 0.85.1`**, at commit `1c749a8` — the probe as committed by that change, bare, no `--tool-check`.
`"result": "pass"`, exit 0, 41 seconds wall clock (23:37:00.236 to 23:37:41.650 local, `-04:00`), client rebuilt rather than reused (`build.returncode: 0`) and `built_client` answering HTTP 200 with `has_app_mount: true`, so the commit named above is the code that served the run.

**The model is on the SSE stream, and the evidence now carries it: `openrouter/deepseek/deepseek-v4.1-flash`.**
`checks.model` reported `{"result": "pass", "at": "2026-09-13T23:37:39.672-04:00", "model": "openrouter/deepseek/deepseek-v4.1-flash", "event_type": "snapshot"}` — read off a `snapshot` event at the instant the first turn returned to idle, the same timestamp `checks.idle` reports, which is the settled point the run was already asserting on.
No second `get_state` beside the server and no extra request: `SseReader` had already buffered the event, and both the `snapshot` and the `status` arms of `ServerEvent` carry `model` (`src/shared/protocol.ts`), filled from `PiProcess`'s own field (`src/server/adapters/pi/process.ts`).
The `GET /api/sessions/:backend/:id` body the probe also holds would not have served: `SessionSummary` has no model field.

**The string the server reports is not the string `settings.json` names.**
`~/.pi/agent/settings.json` was measured earlier that evening selecting `deepseek/deepseek-v4.1-flash` (see "Pi arrives on the home server"); what came back through `get_state` and out over SSE is `openrouter/deepseek/deepseek-v4.1-flash`, provider prefix included.
The two agree on the model, but a reader matching them literally would conclude they disagree — so cite the wire string when quoting a run's evidence and the settings string when quoting the file.

**The check fails loudly rather than recording an empty field.**
`model` is `null` until `start()`'s `get_state` answers, so an early `status` event can legitimately carry nothing.
Deliberately broken first, by reading a field name that does not exist: the run reported `"result": "fail"` with `RuntimeError: no settled snapshot or status event named the model Pi resolved`, exit 1, and `checks` stopping at `idle` — so the check has been seen red, and a future Pi that stops reporting a model will stop this probe instead of quietly dropping the field.

**Reproduced once more from `main`, by a second hand.**
The run above was made by the agent that wrote the change, on its own branch; the same probe was then run again from the main checkout at `9b0bfc1`, bare, and reported `"result": "pass"` with `checks.model` reading `{"result": "pass", "at": "2026-09-13T23:40:29.435-04:00", "model": "openrouter/deepseek/deepseek-v4.1-flash", "event_type": "snapshot"}`.
Same model string, same event type, same settle point — so the field is not an artifact of one run's timing.

## The Pi smoke probe's abort is now provably aimed at the long turn (OW-hahohi)

Run on the home server 2026-09-13, **`pi 0.85.1`**, from the `card/OW-hahohi` worktree at the commit that landed here as `787e2dd` — the probe as that change committed it, twice: once with `--tool-check` and once bare.
Both reported `"result": "pass"` with every check inside them passing, and both exited 0: the `--tool-check` run took 19 seconds (23:45:23.382 to 23:45:42.128 local, `-04:00`), the bare run 10 seconds (23:45:49.793 to 23:45:59.803).
The client was rebuilt rather than reused in both (`build.returncode: 0`, no `--skip-build`) and `built_client` answered HTTP 200 with `has_app_mount: true`, so the commit named above is the code that served the runs.
Each run's own `checks.model` reported `{"result": "pass", "model": "openrouter/deepseek/deepseek-v4.1-flash", "event_type": "snapshot"}` — the wire spelling, provider prefix included, as OW-guvojo's section above explains.
Nothing passed `--model`; Pi resolved that from the `settings.json` copied into the throwaway state home.

**The tool turn and the aborted turn are now separated by a recorded idle point, not by a reader subtracting timestamps.**
`checks.tool_output` gained the tool turn's own settle: `{"at": "2026-09-13T23:45:39.606-04:00", "blocks": ["thinking", "toolCall"], "turn_streaming_at": "2026-09-13T23:45:39.006-04:00", "turn_idle_at": "2026-09-13T23:45:40.138-04:00", "turn_idle_event_type": "snapshot"}`.
`checks.abort` then carries `"streaming_before_long_prompt": false`, read immediately before the long prompt was posted, with the long turn's own `"streaming_at": "2026-09-13T23:45:40.166-04:00"` — 28 ms after the tool turn went idle.
The bare run reports the same `"streaming_before_long_prompt": false`, where it is structurally guaranteed rather than corroborating: `checks.idle` has just waited for `streaming=false` and no prompt intervenes.
The field's whole force is as a tripwire — remove either idle wait and it fails, which is what the red run below shows.
That field, not the interval, is the assertion: the previous `streaming_at_abort: true` guard answers `true` whichever turn is running, which is exactly how the OW-moradi run passed while aborting an unknown turn.

**The new guard was seen red before it was believed.**
With the fix in place except for the tool turn's idle wait — that is, with the old behaviour of posting the long prompt the moment the `toolCall` block arrived — the `--tool-check` run reported `"result": "fail"`, exit 1, with `RuntimeError: a turn was still active when the long prompt was posted, so the aborted turn would not be the long one (last reported state: True)`.
`checks` stopped after `tool_output`, whose `toolCall` block had arrived at 23:45:18.236, and no `abort` check was written at all.
So the guard fails on precisely the condition the OW-moradi `--tool-check` run met silently.

**The abort itself still behaves, and is still answered in milliseconds.**
`--tool-check`: requested at 23:45:40.567 against a confirmed-streaming turn, idle at 23:45:40.591 — 24 ms — HTTP 204, `assistant_length_at_abort: 449` and unchanged at 449 both when idle and 1.5s later.
Bare: requested at 23:45:58.251, idle at 23:45:58.268 — 17 ms — 467 characters, likewise unchanged through settling.
Those two intervals are genuine request-to-event measurements because `abort_requested_at` is stamped immediately before the request is sent; no other pair of timestamps in the blob may be read as a duration, since the rest are SSE arrival stamps against waits whose events were often already buffered.
The bare run's tree was `bun → bwrap → bwrap → pi`, one Pi descendant reporting `comm=pi`, and SIGTERM left `remaining_worker_pids: []`.
What these runs do not close is the hole the probe's own comment at the `pre_abort` cut names: the cut is taken immediately before the request, so a turn that ended of its own accord during the abort's round trip satisfies every check in this phase.
Here that is a live alternative reading rather than a theoretical one — the declined turn produced a few hundred characters and the abort was issued about 400 ms after `streaming=true` — and closing it needs a causal signal from the backend that the SSE stream does not carry.

**The long prompt was deliberately left as it is, so what the phase establishes is narrower than the prompt reads.**
The prompt asks for the integers 1 through 10000, one per line; as of `pi 0.85.1` the model declines and explains itself instead — 449 under `--tool-check` and 467 bare here, against 472 bare and 467 under `--tool-check` in the OW-moradi runs.
It was not reworded because `resources/probes/agentpane_codex_smoke.py` sends the same string, nothing has measured how that string behaves there, and changing one probe's prompt on a guess is worse than recording what the prompt delivers; a comment beside the prompt now says so at the site.
The phase therefore establishes that `/abort` is accepted against a streaming turn and that the turn stops and stays stopped — and establishes nothing about tearing down a large buffered transcript.
No threshold is asserted on the length, because the model's compliance is not something this probe can require.

**Read `assistant_length_at_abort` as an upper bound, not as the aborted turn's length.**
It is `max_assistant_length` over the pre-abort snapshot, which is the longest assistant message *in the session* — matching the field `agentpane_codex_smoke.py` already reports, and carrying the same limit.
Under `--tool-check` two turns precede the aborted one, so a longer earlier reply would stand in for it, and nothing in the blob attributes the number to a message.
The one bound the blob offers does not settle it: `text_stream` reports the first turn at 77 characters under `--tool-check` and 44 bare, but `growing_assistant_text` returns as soon as growth is established, so that is a mid-stream sample and not the finished reply — and under `--tool-check` the first turn then ran a further 8.5s (`streaming_at` 23:45:30.468 to `idle_at` 23:45:38.971), against roughly 400 ms of wire time for the aborted turn.
So which message the number belongs to is unsettled in both runs, and reading it as the aborted turn's own length is exactly what this field cannot support.
The post-abort growth check inherits the same shape: it compares that session maximum, so a *shorter* message arriving after the abort would not move it.

**Reproduced from `main` after review, at `d628076`.**
The two runs above were made by the agent that wrote the change, on its own branch, and review then corrected the comments and this section's prose; the probe was run again from the main checkout at `d628076`, once with `--tool-check` and once bare, and both reported `"result": "pass"` and exited 0.
`--tool-check` carried `tool_output.turn_idle_at: "2026-09-13T23:54:39.461-04:00"` with `abort.streaming_before_long_prompt: false` and `streaming_at: "2026-09-13T23:54:39.511-04:00"`, and its abort was requested at 23:54:39.911 and idle at 23:54:39.931; bare reported the same `false`, requested at 23:54:55.783 and idle at 23:54:55.801.
So the separation holds across two hands and four runs rather than one pair.
The declined transcript came to 414 characters under `--tool-check` and 427 bare, against 449 and 467 in the pair above and 472 and 467 in the OW-moradi pair — six runs on `pi 0.85.1` that day, none above 472, which is the spread the comment at the prompt now cites instead of a single pair's numbers.
That run also saw the `toolCall` block arrive alone, in a message whose blocks were `["toolCall"]` with no `thinking` beside it, where both runs above and OW-moradi's saw `["thinking", "toolCall"]` — the check asserts the `toolCall` block and not the shape of the message around it, which is why that variation passed unremarked.
Neither limit is a defect this change was asked to fix, and both are named here so the next reader does not rediscover them with a re-run.

## The Pi smoke probe measures the tool turn's own requests (OW-lapuye)

Run on the home server, **`pi 0.85.1`**, from the `card/OW-lapuye` worktree at the commit that landed here as `2760e01` — the probe as that change committed it, twice: once with `--tool-check` and once bare.
Both reported `"result": "pass"` with every check inside them passing, and both exited 0: the `--tool-check` run took 11.7 seconds (2026-09-13 23:59:32.105 to 23:59:43.829 local, `-04:00`), the bare run 10.1 seconds (23:59:51.798 to 2026-09-14 00:00:01.910).
The client was rebuilt rather than reused in both (`build.returncode: 0`, no `--skip-build`) and each run's `checks.model` reported `openrouter/deepseek/deepseek-v4.1-flash` off a `snapshot` event, the wire spelling as OW-guvojo's section above explains.
Nothing passed `--model`.
`copied_credential_files` was again `["auth.json", "models-store.json", "settings.json"]`: this machine still has no `models.json` and no `trust.json`, which is the qualification finding 42 turns on.

**The tool turn's requests are now inside a window that exists, and that window is empty.**
The old `agent_requests_seen` was one whole-stream list assigned at the first turn's idle, before the `--tool-check` prompt was ever posted; it is now a dict of per-turn windows built by `requests_in`, each carrying the stream cuts it was taken between.
The `--tool-check` run reported `{"first_turn": {"window": {"from_index": 6, "to_index": 54}, "requests": []}, "tool_turn": {"window": {"from_index": 54, "to_index": 81}, "requests": []}}`, and the bare run reported `first_turn` alone at `7`–`57` with no `tool_turn` key at all.
The tool window opens where the tool prompt was posted and closes at the first cut after that turn reported idle — `checks.tool_output` carried `{"at": "2026-09-13T23:59:41.150-04:00", "blocks": ["thinking", "toolCall"], "turn_streaming_at": "2026-09-13T23:59:40.663-04:00", "turn_idle_at": "2026-09-13T23:59:41.833-04:00"}`, the idle wait OW-hahohi added being what gives the window an end.
So this is the first run of anything that could have observed a dialog request raised by a Pi tool turn.
The two windows are contiguous — 54 to 54 — so nothing between them fell outside both.
Read that as a property of the run and not of the probe: `first_turn`'s end and `tool_start` are two separate `len(stream.snapshot())` calls, so an event arriving between them would land in neither window.

**The empty window was shown to be a real slice rather than a slice of nothing.**
An empty list is the same output whether the window is measuring correctly or is simply misaddressed, so the predicate was temporarily relaxed to `event.get("type") in ("request", "upsert")` for one throwaway run, which is not in the committed change.
That run's two windows — `7`–`55` and `55`–`83` — carried 42 and 23 entries respectively, so both slices do cover live traffic and the tool window in particular is not an empty range.
The throwaway also added a `_type` key to each entry so the relaxed matches were distinguishable, which `requests_in` does not emit; neither edit is in the committed change.
That establishes the windowing, not the extraction: nothing here has ever seen a live `type: "request"` event from Pi, and the `kind` field's shape is believed from `src/server/adapters/pi/reducer.test.ts`, which asserts `result.request` for a `select` dialog method and its absence for a fire-and-forget `notify`.

**Three limits stand on the repaired field.**
The field can only ever see an `extension_ui_request` carrying a dialog method — the Pi adapter's sole source of a `request` event — so "empty" will never mean "Pi asked nothing", only "no dialog request reached the wire"; the docstring at `requests_in` now says so at the site.
The abort and shutdown phases are still outside every window, exactly as they were before this change, because the card asked for the tool turn and nothing wider.
And the `tool_turn` key is written only after `tool_turn_idle` resolves, so it exists only on the happy path: a dialog request that actually *blocked* the turn is precisely what would stop that turn reaching idle, the 180-second wait would raise, and the blob would carry no `tool_turn` key at all — shape-identical to a bare run, though the run would report `"result": "fail"` naming that wait.
So this window can witness a non-blocking `request` event during the tool turn, and cannot witness a blocking one; OW-johano carries that.

**What this does to finding 42.**
`docs/HANDOFF.md` finding 42 was rewritten in the same change to say what was measured rather than what the old field appeared to say.
Its claim survives in narrowed form — a shell tool *call* reached the wire with no dialog request beside it — and is now dated to `pi 0.85.1` on this machine, where no `trust.json` was copied, rather than resting on the `pi 0.84.1` laptop run whose evidence column could not carry it.
The headline previously read "Pi ran a shell tool", which nothing has ever measured: the probe's `tool_called` predicate matches a `toolCall` block and no run has recorded a `toolResult`, exactly as the OW-moradi section above already noted about the same predicate.
That is now stated as a limit on the finding rather than left in its headline.

**Reproduced from `main` after review, at `719a1b4`.**
The two runs above were made by the agent that wrote the probe change, on its own branch; review then corrected finding 42's headline and this section's prose, and the probe was run again from the main checkout, once with `--tool-check` and once bare.
Both reported `"result": "pass"` and exited 0, on `pi 0.85.1`, each naming `openrouter/deepseek/deepseek-v4.1-flash` and copying the same three credential files.
The `--tool-check` run (2026-09-14 00:03:31.927 to 00:03:43.215 local, `-04:00`) reported `first_turn` at `7`–`63` and `tool_turn` at `63`–`95`, both with `"requests": []`, around a `checks.tool_output` of `{"at": "2026-09-14T00:03:40.655-04:00", "blocks": ["thinking", "toolCall"], "turn_streaming_at": "2026-09-14T00:03:40.206-04:00", "turn_idle_at": "2026-09-14T00:03:41.174-04:00"}`.
The bare run (00:03:43.403 to 00:03:54.034) reported `first_turn` at `7`–`56` and again no `tool_turn` key.
The windows are wider here than in the pair above and their boundaries fall at different indices, which is what a window pinned to stream position rather than to a fixed count should do; the two windows were again contiguous, at 63.
So the tool window holds across two hands and four runs, and it has been empty in all of them.

## A prompt posted mid-turn is steered into Pi's running turn (OW-yuyofu)

**2026-09-14, home server, `pi 0.85.1`, through agentpane's own built server on the production `direnv exec <workspace> sbox -- pi --mode rpc` chain.**

`resources/probes/agentpane_pi_steer_probe.py` carries the run.
The first four runs were made from the `card/OW-yuyofu` worktree cut at `891d487`, at the probe's content as it landed here in `0b39003`; the probe has since been corrected twice by review, as the closing paragraphs of this section record, and the current file is the one to re-run.
Re-run it with `python3 resources/probes/agentpane_pi_steer_probe.py`.
It passes `--model openrouter/deepseek/deepseek-v4.1-flash:high` through the create-session route rather than relying on `~/.pi/agent/settings.json` the way `agentpane_pi_smoke.py` does, and every run below read back `openrouter/deepseek/deepseek-v4.1-flash` off a `snapshot` event — the wire spelling, carrying the provider prefix the settings file's string does not, as OW-guvojo's section explains.
`copied_credential_files` was `["auth.json", "models-store.json", "settings.json"]` in all six runs; this machine still has no `models.json` and no `trust.json`.
One half of the pin is confirmed only in argv: the flag carries `:high` and the wire spelling does not, so what came back confirms the model and not the thinking level.

**The verdict is the first of D16's three: the marker was answered inside the running turn.**
What carries that verdict is one fact and not two — Pi named the queue.
The `agent_settled` census below is a necessary condition and not a sufficient one: it rules out a follow-up delivered after the turn, but a `followUp` queue drained inside the same span would read identically, because `src/server/adapters/pi/reducer.ts` records that an `agent_end` can be followed by queued continuations.
Read the `queue_update` as the evidence and the boundary census as corroboration.
The reference run started 2026-09-14 00:18:25.395 local (`-04:00`) and reported `"result": "pass"` with every check inside it passing, exiting 0.
Pi's own census for the whole run was **one** `agent_start`, one `agent_end` and one `agent_settled`, around two `turn_start`/`turn_end` pairs, two `queue_update`s, four `message_start`/`message_end` pairs and 1395 `message_update` deltas.
One agent loop, opened by the first prompt and closed after the marker was answered.

**Pi named the queue it put the text in.**
The tap's line count was pinned at 177 immediately before the POST, and line 178 — the very next thing Pi wrote — was:

```json
{"type": "queue_update", "steering": ["Ignore the gardening guide. Reply with exactly this token and nothing else: AGENTPANE-STEER-6DFB2120"], "followUp": []}
```

`steering`, not `followUp`.
The matching drain is `queue_update` at line 1345 with both arrays empty, sitting between the second `turn_start` and the steered `message_start`.

**The structure between the request and the answer.**
Everything below is strictly after the pinned cut, in Pi's own emission order:

| line | event |
| --- | --- |
| 178 | `queue_update`, marker in `steering` |
| 179 | `response` to `prompt`, `success: true` |
| 1342 | `message_end`, role `assistant`, 12575 chars, no marker |
| 1343 | `turn_end` |
| 1344 | `turn_start` |
| 1345 | `queue_update`, both queues empty |
| 1346–1347 | `message_start`/`message_end`, role **user**, 100 chars, marker present |
| 1348 | `message_start`, role `assistant` |
| 1411 | `message_end`, role `assistant`, 24 chars, **marker present** |
| 1412 | `turn_end` |
| 1413 | `agent_end` |
| 1414 | `agent_settled` |

No `agent_settled` falls between the request and the answering assistant message, so the session never returned to idle in between — the marker was answered without the turn the prompt was posted into ever ending.
The HTTP status was 202 and `isStreaming` read `true` at the instant of the post.
The run recorded `seconds_from_steer_request_to_idle: 30.343`, which is a `time.monotonic()` interval and not one arrival stamp minus another — but the probe as it stood built that field *after* its own 2 s settle pad, so about 28.3 s of it is the turn and the rest is the probe waiting.
The field is stamped before the pad from the sixth run below onward; read the four branch runs' figures as 2 s long.

**`agent_settled` is the boundary, and the two finer signals are not.**
Pi's `turn_start`/`turn_end` bound one LLM round, and a steered message is drained into a round of its own — the clean run above has two of them — so the "every post-steer notification carried the same turn id" reading that settled Codex under OW-tifuha has no Pi equivalent, and counting `turn_*` would call a perfect steer a second turn.
`agent_end` is the inner agent loop ending, which `src/server/adapters/pi/reducer.ts` already records "can be followed by retry/compaction/queued continuations", and it is not what agentpane turns into a turn boundary; `reducer.ts` maps `agent_settled`, and only `agent_settled`, to `isStreaming: false`.
The probe therefore decides on `agent_settled` and records `agent_end_between` for the reader without letting it decide anything.
That boundary was widened from `agent_end` after a run disagreed, which is the shape of a boundary chosen to fit the answer — so it is worth saying that the repo already held the independent proof, captured long before this probe existed and with no steer involved.
`resources/fixtures/pi/tool-read.jsonl` and `tool-edit.jsonl` each hold **two** `turn_start`/`turn_end` pairs inside a single `agent_start`…`agent_settled` span, against one pair in `text.jsonl`; and `src/server/adapters/pi/protocol.ts` types `turn_start` as `{ type: "turn_start" }`, with no id, so OW-tifuha's "same turn id" test is not merely inapplicable to Pi but impossible.
An agentpane turn already demonstrably spanned several of Pi's.

**That distinction was not theoretical: `agent_end` came out both ways.**
Four runs were made between 00:16 and 00:20, all four with the marker queued as `steering` and answered, and all four with zero `agent_settled` in between.
Three had zero `agent_end` in between.
The run at 00:17:06 had one: its first reply finished at 3618 characters rather than the 9922–12575 the others produced, Pi closed the loop with `agent_end`, and then opened a **second** `agent_start` to drain the same `steering` queue — census two `agent_start`, two `agent_end`, one `agent_settled`.
So whether the steer is drained inside the first agent loop or into a fresh one is a race against how much the model had left to say, while whether the session leaves the turn is not: it did not, in any of the four.

**What the runs did not show.**
No run cut an in-flight assistant message short.
In every one the first reply ran to its own `message_end` before the steered user message appeared, so this measures the request being accepted mid-turn and answered without the turn ending, not a steer truncating generation — the same caveat OW-tifuha's Codex section carries.
Neither did any turn here call a tool.
Pi's steering is documented to deliver after the current *tool batch*, and every run was a pure text turn on an explicit "do not use tools" prompt, so the tool-batch case is untested.
And this is the `submit()` path only: nothing here exercised `streamingBehavior: "followUp"`, which the adapter never sends, so "Pi would have queued it for a following turn had we asked" is inference and not measurement.

**The discriminating check was broken on purpose first.**
A temporary `if verdict["verdict"] != "dropped": raise` was added after the classifier and the probe re-run live at 00:19:19, asserting the outcome the evidence contradicts.
It went red and exited 1, with `"result": "fail"` and `"error": "RuntimeError: DELIBERATE BREAK: expected dropped, got steered_into_running_turn"`, on a run whose own `checks.verdict` still read `steered_into_running_turn`.
An earlier break at 00:17:06, against a first draft of the classifier that decided on `agent_end` rather than `agent_settled`, is the run described above: it reported `"got indeterminate"` because the queue said steering and the `agent_end` count said following turn.
That disagreement is what moved the boundary to `agent_settled` and is why the classifier reports `indeterminate` as a failure rather than picking a side.
Neither edit is in the committed probe, and the reference run's file is byte-identical to the probe as `4f1c83a` committed it, which landed here as `0b39003`.

**Run five: reproduced from `main`, by a second hand.**
Started 2026-09-14 00:23:16.803 local (`-04:00`), from the main checkout, `"result": "pass"`, exit 0, the same `pi 0.85.1` and the same `openrouter/deepseek/deepseek-v4.1-flash` read off a `snapshot`.
The probe file it ran was byte-identical to what was committed 50 seconds later as `9a50201` — the docstring correction below was in the working tree, uncommitted, when it ran.
Verdict `steered_into_running_turn` again, the marker queued as `steering` with `followUp` empty, `agent_settled_between: 0` and — this run's first reply running to 11476 characters — `agent_end_between: 0` as well.
The structure between the cut and the answer repeated exactly: `queue_update` naming `steering`, the `prompt` `response`, the first reply's `message_end`, `turn_end`, `turn_start`, a drained `queue_update`, the steered **user** message, and the 24-character assistant `message_end` carrying the marker.

**Three defects review then found in the probe, and run six on the corrected one.**
None of them changes any verdict above — every run had the marker in `steering` and an answer carrying it — but two of them meant the probe was weaker than the write-up implied.

*It could not go red on the outcome that matters.* `checks.verdict` passed on anything that was not `indeterminate`, so a `dropped` run — the outcome this card said would be a divergence from D16 — reported `"result": "pass"` and exit 0.
That is why the deliberate break below had to be hand-written as `if verdict["verdict"] != "dropped": raise`.
Only `steered_into_running_turn` is a pass now, and `dropped` and `following_turn` each raise.

*The one discriminating reading was optional.* A run with no `queue_update` naming the marker fell back to the `agent_settled` boundary alone and still passed, on a reading that cannot tell a steer from a drained follow-up.
The queue reading and the boundary reading must now agree, so that case is `indeterminate` and raises.
Exercised offline against synthetic timelines, the classifier now returns `steered_into_running_turn` only for the steer shape, and `indeterminate` for a `followUp` queue, a `followUp` queue drained with no `agent_settled`, an answer arriving after an `agent_settled`, and a timeline with no `queue_update` at all — five shapes, every one of them red.

*The shim does not pass Pi's exit status through.* It was described as transparent in "stdin, stdout and exit status", but `exec pi "$@" | tee` reports the pipeline's last stage, so the server sees `tee`'s status and never Pi's.
Nothing in the probe reads the agent's exit code, so no run is affected; the docstring now says so, for whoever copies this shim next.

Run six, on the corrected probe, started 00:34:24.804 local, `"result": "pass"`, exit 0, `pi 0.85.1`, `openrouter/deepseek/deepseek-v4.1-flash` off a `snapshot`, verdict `steered_into_running_turn` with `by_queue` and `by_turn_boundary` agreeing, `queued_as: "steering"`, `agent_end_between: 0`, `agent_settled_between: 0`, `seconds_from_steer_request_to_idle: 19.642` — the first of these figures to exclude the settle pad — and `cleanup.result: "pass"` with no orphans.
Six runs now, on two checkouts, none of which left the turn.

**Cleanup held.** All six runs reported `cleanup.result: "pass"` with no orphaned worker pids, so the `sh` and `tee` the stdout tap adds to the sandbox tree are reaped with the agent.
The orphan check is not vacuous here: `agentpane_live_support.py` enumerates the server's descendants through the probe's own `worker_filter` *before* killing the server and then polls those recorded pids for liveness, so reparenting at teardown cannot hide one, and the filter matches `tee` by `comm` and the shim's `sh` by the `--mode rpc` in its argv.

## Forking the most recent turn and attaching the fork, on all three backends (OW-lajehi)

Run on the home server 2026-09-15 by `resources/probes/fork_attach_probe.py`, against `pi 0.85.1` on `openrouter/deepseek/deepseek-v4.1-flash:high`, `codex-cli 0.154.0` on `gpt-5.6-luna`, and `claude 2.1.270` on `haiku` -- each model named to the create route rather than inherited from a settings file.
The owner's report is what it was built for: editing the last message sometimes fails to attach to the fork, on a backend nobody could name.

The probe is the missing middle between the two vehicles that already existed.
`fork_probe.py` drives the CLIs directly and never sees agentpane's session manager; the browser suite in `e2e/` runs the real client against a synthetic backend and has no server at all (OW-24).
This one drives the production HTTP server: two real turns, `GET fork-points`, `POST fork` at the **last** point, `GET` the fork -- which is `controller.ts` `forkAndSubmit`'s sequence -- then a turn inside the fork, a re-attach, a fork of the fork, and a second fork of the parent at the same point.
It reports rather than asserts, so a failing attach is recorded with its status and body and the run continues.

**Codex failed at the attach, every time, and now passes.**
Measured before the fix: `POST .../fork` answered 201 and the forked rollout was on disk within a millisecond, but the attach answered `500 internal_error`, `thread <forkId> already has an active writer` -- and still did five seconds later.
The holder was the parent session's own app-server process: `DELETE` the parent, and the identical attach on the same fork ref answered 200.
In the browser that was the whole of "edit the last message" on Codex -- `forkAndSubmit` threw at `api.attach` and published the app-server's sentence into the error banner -- and it is what OW-lajehi was filed for.

The same probe was re-run on the home server later that day, against the same `codex-cli 0.154.0`, once the fix had landed on `main`, and **every step passes**: `fork_http` 201, `attach_http` 200, a turn landing in the fork, the re-attach, the fork of the fork, and a second fork of the parent, with the parent still attachable after all of it.
The fork's transcript is correctly truncated -- the parent answered ONE and TWO, the fork keeps ONE, replaces TWO's turn, and answers THREE -- and the run left no orphaned worker processes.
The fix is that the fork's adapter borrows the parent's app-server instead of spawning its own: `src/server/adapters/codex/connection.ts` holds one child for N adapters and kills it only when the last one lets go.
It did **not** then cover re-attaching one side of a fork pair after closing it while the other still lives, which was refused exactly as above; that is OW-voyezi, fixed later the same day, and the two sections at the end of this file are its evidence.

**This retires half of OW-22.** That card settled on `codex-cli 0.148.0` that Codex "flushes the forked rollout to disk before any turn, so a fresh attach on the returned ref finds it", and the disk half still measures true; what stopped being true on 0.154.0 is the inference, because a second app-server process may not open a thread the first still holds. The three code comments that carried that inference -- `codex/adapter.ts` `fork`, the `fork` route in `http/app.ts`, and `ForkResult` in `adapters/types.ts` -- were corrected first to record the defect and then again, by the fix, to describe the borrow.

**Two harness defects, both worth the words, because both look exactly like the product failing.**
The probe first relocated each backend's state with `CODEX_HOME`, `PI_CODING_AGENT_DIR` and `CLAUDE_CONFIG_DIR`, the way the two smoke harnesses do.
That moves the CLI and not the server: agentpane derives its session roots from `homedir()` and reads none of those variables (`src/server/sessions/index.ts`, `claude/adapter.ts`'s `DEFAULT_CLAUDE_ROOT`), and the attach this probe measures is exactly the request that consults that index.
Relocated, Claude reported **no fork points at all** and Codex's fork attach answered **404 `no such session`** on a rollout demonstrably on disk -- a plausible, entirely false, second defect.
The run therefore uses the real stores, which OW-vowire made writable; the cost is that it leaves its small sessions in them.

## The app-server that mints a fork can also drive it, and keep the parent (OW-lajehi)

Run on the home server 2026-09-15, `codex-cli 0.154.0` on `gpt-5.6-luna`, by `resources/probes/codex_fork_same_process_probe.py`, against `codex app-server` directly with no agentpane in the picture.
The section above establishes that a second process is refused; this one asks whether the first process can do the work instead, which is what decides OW-lajehi's fix.

One process, one JSON-RPC client, two turns on a parent thread, then `thread/fork` keeping the first turn.

**The control reproduces the refusal away from agentpane.** A second `codex app-server`, started while the first still lives, answering `thread/resume` on the forked thread with JSON-RPC `-32600`, `thread <id> already has an active writer`. The error code is worth recording: it is `InvalidRequest`, not a transport failure, so it is a decision the server is making.

**A. `thread/resume` on the fork succeeds in the process that minted it**, returning the forked thread with its own `sessionId`.

**B. `turn/start` against that forked thread completes there**, `status: "completed"`, the reply being the word the prompt asked for.

**C. The parent is still drivable afterwards.** A further `turn/start` on the parent thread id, after the fork had been resumed and driven in the same process, completed with its own reply. So one app-server holds both threads at once and visiting the fork costs nothing on the parent -- previously an inference from the reducer's `threadId` filtering (`codex/reducer.ts`, the notification arm that drops a foreign `threadId`), now measured.

What this settles for OW-lajehi: the fork is drivable, by exactly one process, and that process is the parent's.
The fix is therefore to let the fork's adapter borrow the parent's client rather than spawn its own, and the cheap alternative that card carried -- disposing the parent at fork time -- is declined on this evidence rather than on taste, since nothing needs the parent's process to go away.

## `thread/unsubscribe` does not release a Codex thread's writer lock (OW-voyezi)

Run on the home server 2026-09-15, `codex-cli 0.154.0` on `gpt-5.6-luna`, by `resources/probes/codex_unsubscribe_probe.py`, against `codex app-server` directly.
This is the question OW-voyezi turned on: once a fork borrows its parent's app-server (OW-lajehi), closing one side of the pair no longer kills the child, so something else has to let go of the closed side's thread -- and `thread/unsubscribe` was the only candidate in the protocol.

The vehicle is `codex_fork_same_process_probe.py`'s: one owner process with a parent thread and a fork of it, one intruder process, and every question answered by which of `result` and `error` comes back.

**The control holds.**
With the owner holding both threads, the intruder's `thread/resume` on the parent is refused with `-32600`, `thread <id> already has an active writer`.

**`thread/unsubscribe` answers `{"status": "unsubscribed"}` and changes nothing the lock cares about.**
The intruder's next `thread/resume` on that same parent thread is refused with the identical `-32600`.
The symmetric half is the same: the fork -- the thread the owner *minted* rather than resumed -- is refused to the intruder before the unsubscribe and refused again after it.

**The owner can resume a thread it already holds, and drive it.**
`thread/resume` on the parent a second time, with no unsubscribe in between, returns the thread; a `turn/start` on it then completes and answers.
It also succeeds after the owner has unsubscribed that thread itself.
And unsubscribing the parent costs the owner nothing on the fork: a turn on the fork completes afterwards, so unsubscribe is per-thread, not per-process.

What this settles: of the two fixes OW-voyezi named, the `thread/unsubscribe` one does not exist.
Nothing short of the child dying releases a Codex thread as of 0.154.0, so a re-attach on a thread a live app-server still holds has to come back to *that* app-server -- which the second measurement above says is allowed.
`src/server/adapters/codex/connection.ts` now carries a `CodexConnectionRegistry` of live connections by thread id, `CodexAdapter.start` borrows from it instead of spawning when a resume names a held thread, and the entry is dropped by the connection itself on the last release and on the child's exit.

## Closing one side of a Codex fork pair and re-attaching it (OW-voyezi)

Run on the home server 2026-09-15, `codex-cli 0.154.0` on `gpt-5.6-luna`, by `resources/probes/fork_attach_probe.py --backend codex`, which grew a step for this: close one side of the fork pair and attach it again while the other side is still live, in both orientations.
Both orientations were run against the same tree with the fix held back and again with it applied, so the step is known to discriminate.

**Without the fix, both fail with the defect's own sentence.**
Closing the parent and re-attaching it answered `500 internal_error`, `thread <parentId> already has an active writer`; closing the fork and re-attaching it answered the same on the fork's id.
`second_fork_of_parent` failed with them, as collateral -- the parent could not be attached, so nothing could be forked out of it.

**With the fix, every step passes**, including the two new ones and the whole of the sequence OW-lajehi established: `fork_http` 201, `attach_http` 200, a turn in the fork, the re-attach, the fork of the fork, the second fork of the parent, and no orphaned workers.

The step is Codex's alone, and the probe guards it on the backend for that reason: Pi and Claude Code spawn a child per session and have no shared app-server to re-borrow.

## Pi's mid-stream fork, and the forked file on disk, re-measured at the instrument (OW-gajesu)

Run on the home server 2026-09-15, `pi 0.85.1`, by the same re-runnable vehicle as the OW-mewiga and OW-yudoni sections above: `python3 resources/probes/fork_probe.py --backend pi --no-fixtures`, which exited 0.
The probe copies `~/.pi/agent/settings.json` into a throwaway state home and launches `pi --mode rpc` with no `--model` flag, so the model is whatever that file resolves to; `get_state` reported `deepseek/deepseek-v4.1-flash` ("DeepSeek: DeepSeek V4.1 Flash", provider `openrouter`) at `thinkingLevel: "high"` in every state read the record carries.
This run exists because the OW-yudoni section had already recorded that two of the three things its mid-stream cell observed were not evidence for the claim the repo went on to state flatly, and because the disk-timing flag had been read both ways at two different instruments.
The cell has since been changed on both counts — it forks at the second entry and it reads the file the turn was streaming into — and this is the first run of it.

**The mid-stream fork's message count is now a result rather than a tautology.**
The cell forked at entry `52938741`, `Say exactly: DELTA`, the **second** user message of the branch, and recorded what exclusive semantics predict for that point before reading anything: `midstream_expected_message_count: 2`.
The `get_state` taken immediately after the fork reported `messageCount: 2`, and `midstream_messages_tail` was `ALPHA -> ALPHA` — the first turn, intact.
The streaming turn's own absence from that branch says nothing either way, since it is downstream of the fork point and exclusivity excludes it regardless.
What the second-entry fork newly excludes is that a mid-stream fork empties the branch it produces: on the 2026-08-20 run, which forked at the first user message, `messageCount: 0` was what exclusivity alone guaranteed, and there was no way to tell it from a branch the fork had emptied.

**The abandoned turn left no reply in the file it was streaming into.**
`midstream_state_before_fork` confirmed the turn was live — `isStreaming: true`, `messageCount: 7`, `sessionFile` ending `…01a0a74b-0685….jsonl` — and the fork returned `success: true` with `{ "text": "Say exactly: DELTA", "cancelled": false }` (`midstream_fork_return`).
`midstream_state_after_fork` reported a different `sessionFile` (`…01a0a74b-0f21….jsonl`) and `isStreaming: false`, `midstream_turn_settled: true`, and `midstream_assistant_reply_preview: ""`.
Reading `midstream_abandoned_file_messages` — the pre-fork file, which the 2026-08-20 run never opened — it holds eight messages: `ALPHA -> ALPHA -> DELTA -> DELTA -> EPSILON -> EPSILON`, then the streaming turn's user message `Write the numbers 1 through 400, one per line, with no prose.` and an assistant entry whose text is `""`.
So what is proven is that the streamed-into file ends with the turn's own user message and an assistant entry carrying no text.
That is stronger than the 0.84.2 run's settle alone, and it is still short of proving that streamed text was *discarded*.
The instrument is why: this cell gates only on `agent_start` before it fires the fork, with no accumulating-delta threshold and no count of what had streamed, unlike its Codex sibling `codex_fork_mid_stream`, which waits on five deltas and reports `result: "unearned"` when the signals are missing (`resources/probes/README.md`, "the streaming discipline").
The session files' own timestamps put the fork about 2.2s after the prompt, on a reasoning model at `thinkingLevel: "high"`, so "the fork threw away text that had been produced" and "no text had been produced yet" are both consistent with this record.
A run that closed it would carry that cell's delta gate into this one — hold the fork until some number of assistant text deltas have accumulated, record the count, and re-read the buffer at the instant the fork request goes out — so that the empty entry on disk can be set against text known to have existed.
Two smaller bounds: `pi_file_messages` projects text blocks only, so a reasoning-only entry would read empty here too, and nothing was read from that file before the fork.

**`moved_file_on_disk_at_fork: true`, measured where the 2026-08-19 run measured it.**
That run read `false` and the 2026-08-20 run read `true`, but the second had put a `get_messages` round-trip between the `fork` and the `get_state`; the cell now takes the `get_state` as the first round-trip after the `fork`, where 2026-08-19 took it, and reads `true` there.
So the `false` did not survive a run at its own instrument, which is what retires it.
It does not follow that the added latency was never the difference: `pi` went 0.84.2 → 0.85.1 and the machine went work laptop → home server between those two runs, and the flag is a race sampled once per run, so one `true` at that instrument is a sample and not an invariant.
`moved_file_messages_at_fork` says what that file holds before any prompt: `ALPHA -> ALPHA`, the rewound prefix, already written.
A fork the user then discards therefore costs a real session file carrying the branch up to the fork point, not nothing — which is the reading the OW-pifowo section above left open, and the session-picker consequence it named is the live one.
`active_file_moves_at_fork: true` again, unchanged across all three runs.

The rest of the cell reproduced 0.84.2's findings on 0.85.1 unchanged: `copy_on_write: true`, `original_file_unchanged: true`, the original's tail still the abandoned `GAMMA`, `new_file_parentSession` pointing back at the pre-fork file, and `forked_message_present_in_get_messages: false` with `ALPHA -> ALPHA -> DELTA -> DELTA` on disk after the re-ask — the exclusive fork contract.
