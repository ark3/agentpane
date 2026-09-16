#!/usr/bin/env python3
"""Can each backend rename an attached session mid-session, and where does the name land?

D13 decided (2026-09-15) that a session name set in agentpane is written through
to the backend and kept nowhere of agentpane's own.  That is only a decision if
all three backends accept a rename over the wire they already speak to
agentpane, on a session that has run a turn, without a restart.  This probe
drives exactly that on one backend per run and reports where the name went:

  pi      `pi --mode rpc`; one prompt, then `set_session_name` twice, then
          `get_state`.  Reads back the session file for `session_info` lines.
  claude  `claude -p` in stream-json; one prompt, then a `rename_session`
          control request, then a `/rename <name>` user message.  Reads back
          the store file for `custom-title` lines.
  codex   `codex app-server`; `thread/start`, one turn, then `thread/name/set`
          twice, then `thread/read` and `thread/list`.  Reads back
          `session_index.jsonl`, the sqlite `threads.name` column, and the
          rollout file (which, as of 0.154.0, never carries the name).

Each run costs one real model turn (two on Claude, because `/rename` runs as a
turn).  Sessions are created under a scratch cwd in the temp area and the store
files are left where the CLI put them.  Models are the pins in AGENTS.md.

    python3 session_name_probe.py --backend pi|claude|codex

Exit 0 when every rename in the run was accepted and the second name is what
the backend reports back; the JSON on stdout says which fields did what.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

NAMES = ("probe name one", "probe name two")
PROMPT = "Reply with the single word ok."


def scratch(backend: str) -> Path:
    d = Path("/var/tmp") / f"agentpane-name-probe-{backend}"
    d.mkdir(parents=True, exist_ok=True)
    return d


class Lines:
    def __init__(self, proc: subprocess.Popen[str]) -> None:
        self.proc = proc

    def send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def read_until(self, pred, limit: float = 120.0, on_other=None):
        assert self.proc.stdout is not None
        deadline = time.time() + limit
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return None
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if pred(ev):
                return ev
            if on_other is not None:
                on_other(ev)
        return None

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def run_pi() -> dict:
    cwd = scratch("pi")
    p = subprocess.Popen(
        ["pi", "--mode", "rpc", "--model", "openrouter/deepseek/deepseek-v4.1-flash:high"],
        cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    )
    io = Lines(p)
    out: dict = {"backend": "pi", "version": subprocess.run(["pi", "--version"], capture_output=True, text=True).stdout.strip()}

    def response(cmd):
        return lambda e: e.get("type") == "response" and e.get("command") == cmd

    io.send({"type": "prompt", "message": PROMPT})
    io.read_until(response("prompt"))
    out["turn_ended"] = io.read_until(lambda e: e.get("type") == "agent_end") is not None
    io.send({"type": "get_state"})
    st = io.read_until(response("get_state"))
    out["name_before"] = st["data"].get("sessionName")
    out["set_responses"] = []
    for name in NAMES:
        io.send({"type": "set_session_name", "name": name})
        r = io.read_until(response("set_session_name"))
        out["set_responses"].append(r.get("success") if r else None)
    io.send({"type": "get_state"})
    st = io.read_until(response("get_state"))
    out["name_after"] = st["data"].get("sessionName")
    session_file = st["data"].get("sessionFile")
    io.close()
    out["session_file"] = session_file
    out["session_info_lines"] = [
        {"line": i, "name": d.get("name"), "parentId": d.get("parentId")}
        for i, d in enumerate((json.loads(l) for l in open(session_file)), 1)
        if d.get("type") == "session_info"
    ]
    out["ok"] = out["set_responses"] == [True, True] and out["name_after"] == NAMES[-1]
    return out


def run_claude() -> dict:
    cwd = scratch("claude")
    sid = str(uuid.uuid4())
    p = subprocess.Popen(
        ["claude", "-p", "--model", "haiku", "--input-format", "stream-json", "--output-format", "stream-json",
         "--verbose", "--session-id", sid],
        cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    )
    io = Lines(p)
    out: dict = {"backend": "claude", "version": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(), "session_id": sid}

    def user(text: str) -> dict:
        return {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}

    io.send(user(PROMPT))
    r = io.read_until(lambda e: e.get("type") == "result")
    out["first_result"] = r.get("subtype") if r else None
    io.send({"type": "control_request", "request_id": "rename-1", "request": {"subtype": "rename_session", "title": NAMES[0]}})
    r = io.read_until(lambda e: e.get("type") == "control_response", 30)
    out["control_rename_response"] = r.get("response") if r else None
    io.send(user(f"/rename {NAMES[1]}"))
    r = io.read_until(lambda e: e.get("type") == "result", 90)
    out["slash_rename_result"] = {k: r.get(k) for k in ("subtype", "result")} if r else None
    io.close()
    munged = "-" + str(cwd).strip("/").replace("/", "-")
    files = glob.glob(os.path.expanduser(f"~/.claude/projects/{munged}/{sid}.jsonl"))
    out["store_file"] = files[0] if files else None
    out["title_lines"] = []
    if files:
        for i, line in enumerate(open(files[0]), 1):
            d = json.loads(line)
            if d.get("type") in ("custom-title", "ai-title"):
                out["title_lines"].append({"line": i, "type": d["type"], "title": d.get("customTitle") or d.get("aiTitle")})
    custom = [t["title"] for t in out["title_lines"] if t["type"] == "custom-title"]
    out["ok"] = (
        (out["control_rename_response"] or {}).get("subtype") == "success"
        and (out["slash_rename_result"] or {}).get("subtype") == "success"
        and custom[:2] == list(NAMES)
    )
    return out


def run_codex() -> dict:
    cwd = scratch("codex")
    p = subprocess.Popen(["codex", "app-server"], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, bufsize=1)
    io = Lines(p)
    out: dict = {"backend": "codex", "version": subprocess.run(["codex", "--version"], capture_output=True, text=True).stdout.strip()}
    counter = {"n": 0}
    notifs: list = []

    def note(ev):
        if ev.get("method") == "thread/name/updated":
            notifs.append(ev["params"])

    def req(method: str, params: dict):
        counter["n"] += 1
        n = counter["n"]
        io.send({"jsonrpc": "2.0", "id": n, "method": method, "params": params})
        r = io.read_until(lambda e: e.get("id") == n, on_other=note)
        if r is None:
            raise SystemExit(f"no response to {method}: {p.stderr.read()[-800:]}")
        return r

    req("initialize", {"clientInfo": {"name": "agentpane-probe", "title": "session_name_probe", "version": "0"}, "capabilities": None})
    started = req("thread/start", {"cwd": str(cwd), "sandbox": "read-only", "approvalPolicy": "never", "model": "gpt-5.6-luna"})
    tid = started["result"]["thread"]["id"]
    out["thread_id"] = tid
    out["name_before"] = started["result"]["thread"].get("name")
    req("turn/start", {"threadId": tid, "input": [{"type": "text", "text": PROMPT}]})
    out["turn_completed"] = io.read_until(lambda e: e.get("method") == "turn/completed", on_other=note) is not None
    out["set_responses"] = []
    for name in NAMES:
        r = req("thread/name/set", {"threadId": tid, "name": name})
        out["set_responses"].append(r.get("error") or r.get("result"))
    out["name_updated_notifications"] = list(notifs)
    out["read_name"] = req("thread/read", {"threadId": tid})["result"]["thread"].get("name")
    listed = req("thread/list", {"cwd": str(cwd)})["result"]["data"]
    out["list_name"] = next((t.get("name") for t in listed if t["id"] == tid), None)
    out["list_model"] = next((t.get("model") for t in listed if t["id"] == tid), None)
    io.close()
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    index = [json.loads(l) for l in open(codex_home / "session_index.jsonl")]
    out["session_index_rows"] = [r for r in index if r.get("id") == tid]
    tmp = Path("/tmp") / f"codex-state-{os.getpid()}.sqlite"
    for suffix in ("", "-wal"):
        src = codex_home / f"state_5.sqlite{suffix}"
        if src.exists():
            shutil.copy(src, str(tmp) + suffix)
    out["sqlite_name"] = sqlite3.connect(tmp).execute("select name from threads where id=?", (tid,)).fetchone()
    rollouts = [f for f in glob.glob(str(codex_home / "sessions" / "*" / "*" / "*" / "*.jsonl")) if tid in f]
    out["rollout"] = rollouts
    out["rollout_mentions_name"] = any(NAMES[0] in open(f).read() or NAMES[1] in open(f).read() for f in rollouts)
    out["ok"] = out["set_responses"] == [{}, {}] and out["read_name"] == NAMES[-1] and out["list_name"] == NAMES[-1]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=("pi", "claude", "codex"), required=True)
    args = ap.parse_args()
    out = {"pi": run_pi, "claude": run_claude, "codex": run_codex}[args.backend]()
    out["measured_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    json.dump(out, sys.stdout, indent=2)
    print()
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
