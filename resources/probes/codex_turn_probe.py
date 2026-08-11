#!/usr/bin/env python3
"""Codex app-server probe — proves the full turn flow over stdio.

Reproduces: initialize -> thread/start -> turn/start -> streaming
`item/agentMessage/delta` -> `item/completed` -> `turn/completed`.

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
        m = e.get("method", "")
        if m.startswith(("item/", "turn/")):
            print("<<", m, "|", json.dumps(e.get("params", {}))[:200])
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

print("=== turn/item method counts ===")
print(Counter(e.get("method") for e in seen
              if e.get("method", "").startswith(("item/", "turn/"))))
p.terminate()
shutil.rmtree(home, ignore_errors=True)
shutil.rmtree(work, ignore_errors=True)
