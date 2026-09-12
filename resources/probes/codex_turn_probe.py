#!/usr/bin/env python3
"""Codex app-server probe — proves the full turn flow over stdio.

Reproduces: initialize -> thread/start -> turn/start -> streaming deltas ->
`item/completed` -> `turn/completed`. Deltas are counted, not printed: the
steer phase below needs the count, and printing them buries everything else.

Then (OW-tifuha) drives a second, deliberately long turn and fires
`turn/steer` at it while it is still streaming, printing the steer response
verbatim and every item/turn notification that follows it, so the transcript
shows whether the steered text lands inside the running turn or opens a new
one.

Codex app-server defaults to stdio:// (no socket needed), so this is
sbox-transparent exactly like Pi's RPC mode.

Usage:  python3 codex_turn_probe.py
Needs:  `codex` on PATH, and a WRITABLE CODEX_HOME with valid auth.
        Because sbox makes ~/.codex read-only, we point CODEX_HOME at a
        temp dir and copy the real auth/config in. (Codex needs a writable
        sqlite state runtime under CODEX_HOME.)
"""
import json, os, shutil, subprocess, tempfile, threading, time
from collections import Counter
from pathlib import Path

# Home-server agent sessions pin Codex to one model (AGENTS.md, "Evidence");
# app-server takes no flag, so the pin rides on the turn/start below that this
# script drives for the steer phase.
MODEL = "gpt-5.6-luna"
LONG_PROMPT = (
    "List the integers from 1 to 200, one per line, each on its own line, "
    "with no commentary before or after. Do not use any tools."
)
STEER_PROMPT = "STOP counting. Instead reply with exactly: steered-marker-ow-tifuha"

home = Path(tempfile.mkdtemp())
real = Path.home() / ".codex"
for f in ("auth.json", "config.toml"):
    if (real / f).exists():
        shutil.copy(real / f, home / f)

work = tempfile.mkdtemp()
subprocess.run(["git", "init", "-q"], cwd=work)

env = dict(os.environ, CODEX_HOME=str(home))
p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     text=True, cwd=work, env=env)

def send(o): p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()

tid, seen = [None], []
# The live turn id, learned from whichever lifecycle notification names it
# first; `turn/steer` needs it as the `expectedTurnId` precondition.
live_turn = [None]
deltas = [0]
mark = [""]

def reader():
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        seen.append(e)
        if e.get("id") == 2:
            tid[0] = e["result"]["thread"]["id"]
        if e.get("id") == 5:
            print("<< STEER RESPONSE |", json.dumps(e))
        m = e.get("method", "")
        if m.startswith(("item/", "turn/")):
            params = e.get("params", {})
            if isinstance(params.get("turnId"), str):
                live_turn[0] = params["turnId"]
            turn = params.get("turn")
            if isinstance(turn, dict) and isinstance(turn.get("id"), str):
                live_turn[0] = turn["id"]
            if m.endswith("/delta"):
                deltas[0] += 1
                continue
            print(mark[0], "<<", m, "|", json.dumps(params)[:400])
threading.Thread(target=reader, daemon=True).start()

send({"id": 1, "method": "initialize",
      "params": {"clientInfo": {"name": "probe", "version": "0", "title": "probe"}}})
time.sleep(2)
send({"id": 2, "method": "thread/start", "params": {}})
time.sleep(3)
print("thread:", tid[0])
send({"id": 3, "method": "turn/start",
      "params": {"threadId": tid[0],
                 "input": [{"type": "text", "text": "Reply with exactly: hello there friend"}]}})
time.sleep(15)

# --- OW-tifuha: steer a turn that is still streaming --------------------
print("=== OW-tifuha: turn/steer against a live turn ===")
live_turn[0] = None
deltas[0] = 0
send({"id": 4, "method": "turn/start",
      "params": {"threadId": tid[0],
                 "model": MODEL,
                 "input": [{"type": "text", "text": LONG_PROMPT}]}})

# Wait for the turn to be visibly streaming before steering: a steer fired
# before the first delta would not prove the request reaches a live turn.
deadline = time.time() + 60
while time.time() < deadline and not (live_turn[0] and deltas[0] >= 20):
    time.sleep(0.2)
if not live_turn[0]:
    raise SystemExit("no turn id after 60s -- nothing to steer; re-run or lengthen the wait")
print(f"steering at turnId={live_turn[0]} after {deltas[0]} deltas")
steer_at = len(seen)
mark[0] = "  [post-steer]"
send({"id": 5, "method": "turn/steer",
      "params": {"threadId": tid[0],
                 "expectedTurnId": live_turn[0],
                 "input": [{"type": "text", "text": STEER_PROMPT}]}})
time.sleep(90)
mark[0] = ""

print("=== post-steer turn ids seen ===")
for e in seen[steer_at:]:
    m = e.get("method", "")
    if m in ("turn/started", "turn/completed"):
        print(" ", m, "|", json.dumps(e.get("params", {}))[:300])

print("=== full agent text after steer ===")
for e in seen[steer_at:]:
    if e.get("method") == "item/completed":
        item = e.get("params", {}).get("item", {})
        if item.get("type") == "agentMessage":
            print(" ", json.dumps(e.get("params", {}))[:1500])

print("=== turn/item method counts ===")
print(Counter(e.get("method") for e in seen
              if e.get("method", "").startswith(("item/", "turn/"))))
p.terminate()
shutil.rmtree(home, ignore_errors=True)
shutil.rmtree(work, ignore_errors=True)
