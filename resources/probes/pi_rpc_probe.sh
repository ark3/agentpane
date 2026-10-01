#!/usr/bin/env bash
# Pi RPC probe — proves `pi --mode rpc` emits AgentMessage-shaped objects.
#
# Runs one turn against a throwaway session and prints the assistant
# message_end payload. That payload is the exact `AgentMessage` type that
# pi-web-ui's MessageList consumes, so the Pi->UI adapter is near-identity.
#
# Usage:  bash pi_rpc_probe.sh
# Needs:  `pi` on PATH with credentials for the pinned model below, a git repo
#         cwd (use /tmp scratch).
set -euo pipefail

# The model AGENTS.md "Evidence" pins agent-driven turns to, passed explicitly
# because Pi's own default lives in a settings file the owner may change.
PI_MODEL="openrouter/deepseek/deepseek-v4.1-flash:high"

WORK="$(mktemp -d)"
cd "$WORK"
git init -q

# Send one prompt, keep stdin open ~25s so the turn can stream back.
( printf '%s\n' '{"type":"prompt","message":"Reply with exactly: hello there friend"}'
  sleep 25
) | timeout 40 pi --mode rpc --no-session --model "$PI_MODEL" > out.jsonl 2>/dev/null || true

echo "=== model flag passed: $PI_MODEL ==="

echo "=== event types seen ==="
python3 -c "import json,sys;[print(json.loads(l).get('type')) for l in open('out.jsonl') if l.strip()]" | sort | uniq -c

echo "=== assistant message_end payload (this is an AgentMessage) ==="
python3 -c "
import json
for l in open('out.jsonl'):
    if not l.strip(): continue
    e=json.loads(l)
    if e.get('type')=='message_end' and e['message'].get('role')=='assistant':
        print(json.dumps(e['message'], indent=1)); break
"
rm -rf "$WORK"
