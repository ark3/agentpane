# Manual testing

## Verification status

The first live production-composed Codex smoke check passed on 2026-08-11
(America/New_York) with `codex-cli 0.147.0`.

The production-built client was fetched successfully from the Bun server, then
a deterministic local harness drove the application's REST and SSE interfaces.
This was **not browser automation**, so it does not claim mouse/keyboard or DOM
interaction in a real browser. The live run did exercise the same HTTP/SSE
transport used by the client and a real Codex process spawned by the production
composition.

**Pi was not live-tested in this environment.** Its four deferred checks are
listed below and remain unverified.

## Reproducible Codex setup

The successful run used these setup commands. They copy credential files by
name without printing their contents and leave the real `~/.codex` untouched.
Do not enable shell tracing while running them.

```bash
APP_ROOT=/home/asa0717/src/agentpane/.worktrees/minimal-live-vertical-slice
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
The automated run walked `/proc` recursively from its own server PID so it
never inspected or killed unrelated Codex processes.

```bash
kill "$SSE_PID_2"
wait "$SSE_PID_2" 2>/dev/null || true

# Record the native Codex PID shown by pstree before stopping the server.
CODEX_WORKER_PID=replace_with_the_run_scoped_native_codex_pid
kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
test ! -e "/proc/$CODEX_WORKER_PID"
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

The final successful run began at `2026-08-11T14:50:48.908-04:00` and ended at
`2026-08-11T14:51:04.685-04:00`.

| Check | Observed result |
|---|---|
| 1. Create a Codex session for `/home/asa0717/src/agentpane` | Passed at `14:50:49.522-04:00`. Create returned HTTP 201, attach returned HTTP 200, and the virtual id was replaced by a real Codex thread id. |
| 2. Submit text only and observe incremental transcript updates | Passed. Prompt returned HTTP 202. The assistant message at index 1 produced 21 observed upserts with 21 distinct increasing text lengths; the completed assistant text was 844 characters. No model wording was asserted or recorded. |
| 3. Observe streaming return to idle | Passed. `isStreaming:true` arrived at `14:50:49.546-04:00`; an authoritative snapshot carried `isStreaming:false` at `14:50:54.169-04:00`. |
| 4. Refresh/reconnect repaint without a duplicate child | Passed at `14:51:04.056-04:00`. A new SSE connection immediately received a two-message snapshot containing the completed 844-character assistant message. Native Codex PID `122009` was the only worker before and after reconnect. |
| 5. Abort a deliberately long prompt | Passed. The second prompt returned HTTP 202 and streamed at `14:51:04.129-04:00`; abort was requested at `14:51:04.510-04:00`, returned HTTP 204, and a snapshot returned to idle at `14:51:04.527-04:00`. |
| 6. Stop the server without an orphaned app server | Passed. SIGTERM was sent at `14:51:04.577-04:00`; the server exited 0 at `14:51:04.585-04:00`. At `14:51:04.685-04:00`, run-scoped native Codex PID `122009` no longer existed. |

Built-client reachability also passed: `/` returned HTTP 200 with the expected
application mount at `14:50:49.046-04:00`.

The stable long-lived process chain observed before and after reconnect was:

```text
bun (server) 121976
└─ bwrap 121995
   └─ bwrap 122001
      └─ node codex launcher 122002
         └─ native codex app-server 122009
```

Production constructs the spawn as `direnv exec <workspace> sbox -- codex
app-server`. `direnv` and the Python `sbox` wrapper exec into the long-lived
processes above, so they did not remain as separate process-tree entries. The
presence of the bwrap namespace and the injected native argument
`--sandbox danger-full-access app-server` confirmed the production sbox path.

The temporary Codex home was absent after cleanup, and no process from the
recorded run-scoped PID set remained. Two earlier harness-only observations
were corrected before accepting evidence: static navigation requires
`Accept: text/html`, and lifecycle state may arrive in a `snapshot` rather than
only a `status` event. Neither required an application source change.

## Deferred Pi verification — unperformed

These four manual checks come from the milestone design. They were recorded but
**not run**, and must not be treated as passing:

- `direnv -> sbox/bwrap -> pi` startup;
- first-prompt virtual-id materialization and the `renamed` event;
- real streaming and tool output in the browser;
- abort and shutdown signal propagation with no orphaned Pi process.
