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

`--when pre-turn|mid-turn` (Claude Code and Codex only, OW-kametu) asks the two
questions the default run never did.  Each puts the CLI in the state
agentpane's adapter leaves it in -- Claude spawned with the adapter's flags and
`get_settings` answered, Codex `initialize`d and `thread/start`ed with the
adapter's policy -- and sends the one rename `setName` would send:

  pre-turn  no prompt at all.  Lists the store before the rename, after it,
            and after the process exits, to see whether a session with no
            conversation is written down.
  mid-turn  one prompt long enough to stream for seconds; the rename goes out
            once 40 text deltas have arrived, and the run records when the
            answer came against the turn's end and how many deltas arrived
            after it.

`--then-prompt` adds to a pre-turn run one short turn after the rename, which
shows whether the name outlives the first turn and that the store path the
run watched is the one the CLI writes to.  It costs that one turn.
`--skip-rename` makes a Codex pre-turn run the control: the same steps with no
rename, so what is on disk afterwards is what `thread/start` alone leaves.

These two run under a fresh scratch cwd in /tmp.  Codex runs in a temporary
CODEX_HOME holding copies of `auth.json` and `config.toml`, because the
session's sandbox mounts ~/.codex read-only; it is left on disk and its path
is in the JSON.  pre-turn costs no model turn, mid-turn one.  Exit 0 when
every request was answered at all; the JSON is the finding.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
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


LONG_PROMPT = "Write the whole numbers from 1 to 400, one per line, with no other text."
DELTAS_BEFORE_RENAME = 40
CLAUDE_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--include-partial-messages", "--model", "haiku"]
CODEX_MODEL = "gpt-5.6-luna"


class Clock:
    def __init__(self) -> None:
        self.t0 = time.monotonic()

    def __call__(self) -> float:
        return round(time.monotonic() - self.t0, 3)


def claude_store_listing(store_dir: Path) -> dict:
    """Every file under the munged cwd's store dir, with each JSONL's line types."""
    out: dict = {}
    if not store_dir.exists():
        return out
    for f in sorted(store_dir.rglob("*")):
        if not f.is_file():
            continue
        types = []
        if f.suffix == ".jsonl":
            for line in f.read_text().splitlines():
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    types.append("?")
                    continue
                t = d.get("type")
                if t in ("custom-title", "ai-title"):
                    t = f"{t}:{d.get('customTitle') or d.get('aiTitle')}"
                types.append(t)
        out[str(f)] = types
    return out


def run_claude_when(when: str, then_prompt: bool) -> dict:
    cwd = Path(tempfile.mkdtemp(prefix=f"agentpane-kametu-claude-{when}-", dir="/tmp"))
    sid = str(uuid.uuid4())
    store_dir = Path(os.path.expanduser("~/.claude/projects")) / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))
    clock = Clock()
    p = subprocess.Popen(["claude", *CLAUDE_FLAGS, "--session-id", sid], cwd=cwd, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    io = Lines(p)
    out: dict = {"backend": "claude", "when": when, "cwd": str(cwd), "session_id": sid, "store_dir": str(store_dir),
                 "version": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip()}
    timeline: list = []
    out["timeline"] = timeline

    def control(req_id: str, request: dict, on_other=None):
        io.send({"type": "control_request", "request_id": req_id, "request": request})
        timeline.append({"t": clock(), "sent": request["subtype"]})
        r = io.read_until(lambda e: e.get("type") == "control_response"
                          and (e.get("response") or {}).get("request_id") == req_id, 120, on_other)
        timeline.append({"t": clock(), "answered": request["subtype"],
                         "subtype": (r or {}).get("response", {}).get("subtype")})
        return (r or {}).get("response")

    # What `ClaudeAdapter.start()` does for a fresh session after the spawn.
    control("settings-1", {"subtype": "get_settings"})
    out["store_before_rename"] = claude_store_listing(store_dir)

    if when == "pre-turn":
        r = control("rename-1", {"subtype": "rename_session", "title": NAMES[0]})
        out["rename_response"] = r
        time.sleep(3)
        out["store_3s_after_rename"] = claude_store_listing(store_dir)
        if then_prompt:
            io.send({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": PROMPT}]}})
            timeline.append({"t": clock(), "sent": "user prompt"})
            r = io.read_until(lambda e: e.get("type") == "result", 120)
            timeline.append({"t": clock(), "result": (r or {}).get("subtype")})
            out["store_after_first_turn"] = claude_store_listing(store_dir)
    else:
        deltas = {"n": 0, "at_rename_answer": None}
        ended: dict = {}

        def watch(ev):
            if ev.get("type") == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta":
                    deltas["n"] += 1
            if ev.get("type") == "result":
                ended.update({"t": clock(), "subtype": ev.get("subtype"), "deltas": deltas["n"]})

        io.send({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": LONG_PROMPT}]}})
        timeline.append({"t": clock(), "sent": "user prompt"})

        def enough(ev):
            watch(ev)
            return deltas["n"] >= DELTAS_BEFORE_RENAME or bool(ended)

        io.read_until(enough, 120)
        out["deltas_when_rename_sent"] = deltas["n"]
        out["turn_ended_before_rename"] = bool(ended)
        out["store_at_rename"] = claude_store_listing(store_dir)
        r = control("rename-1", {"subtype": "rename_session", "title": NAMES[0]}, watch)
        deltas["at_rename_answer"] = deltas["n"]
        out["rename_response"] = r
        out["deltas_when_rename_answered"] = deltas["n"]
        out["turn_ended_before_answer"] = bool(ended)
        out["store_at_rename_answer"] = claude_store_listing(store_dir)
        if not ended:
            io.read_until(lambda e: (watch(e), bool(ended))[1], 180)
        timeline.append({"result": dict(ended)})
        out["deltas_total"] = deltas["n"]
    io.close()
    timeline.append({"t": clock(), "exited": p.returncode})
    out["store_after_exit"] = claude_store_listing(store_dir)
    out["ok"] = out.get("rename_response") is not None
    return out


def codex_store(codex_home: Path, tid: str) -> dict:
    """Where a Codex thread could be written down: rollout, session index, sqlite."""
    rollouts = [f for f in glob.glob(str(codex_home / "sessions" / "**" / "*.jsonl"), recursive=True) if tid in f]
    index_path = codex_home / "session_index.jsonl"
    index = [json.loads(l) for l in open(index_path)] if index_path.exists() else []
    out: dict = {
        "rollouts": {f: len(open(f).read().splitlines()) for f in rollouts},
        "session_index_rows": [r for r in index if r.get("id") == tid],
        "sqlite_row": None,
    }
    db = codex_home / "state_5.sqlite"
    if db.exists():
        tmp = Path(tempfile.mkdtemp(prefix="agentpane-kametu-sqlite-", dir="/tmp")) / "state.sqlite"
        for suffix in ("", "-wal", "-shm"):
            src = Path(str(db) + suffix)
            if src.exists():
                shutil.copy(src, str(tmp) + suffix)
        con = sqlite3.connect(tmp)
        con.row_factory = sqlite3.Row
        row = con.execute("select * from threads where id=?", (tid,)).fetchone()
        if row is not None:
            keep = ("name", "rollout_path", "created_at", "updated_at", "archived", "title", "first_user_message")
            out["sqlite_row"] = {k: row[k] for k in row.keys() if k in keep}
        con.close()
        shutil.rmtree(tmp.parent)
    return out


def codex_fresh_view(cwd: Path, env: dict, tid: str) -> dict:
    """What a second app-server, started after the first exited, makes of the thread."""
    p = subprocess.Popen(["codex", "-m", CODEX_MODEL, "app-server"], cwd=cwd, env=env, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    io = Lines(p)
    answers = []
    for n, (method, params) in enumerate((
        ("initialize", {"clientInfo": {"name": "agentpane-probe", "title": "session_name_probe", "version": "0"},
                        "capabilities": None}),
        ("thread/list", {}),
        ("thread/read", {"threadId": tid}),
        ("thread/resume", {"threadId": tid, "cwd": str(cwd), "sandbox": "danger-full-access",
                           "approvalPolicy": "never", "model": CODEX_MODEL, "excludeTurns": True}),
    ), 1):
        io.send({"jsonrpc": "2.0", "id": n, "method": method, "params": params})
        answers.append((method, io.read_until(lambda e: e.get("id") == n, 60)))
    io.close()
    out: dict = {}
    for method, r in answers[1:]:
        if r is None or r.get("error"):
            out[method] = {"error": (r or {}).get("error")}
        elif method == "thread/list":
            out[method] = {"listed_ids": [t["id"] for t in r["result"]["data"]],
                           "listed_this_thread": any(t["id"] == tid for t in r["result"]["data"])}
        else:
            out[method] = {"name": r["result"]["thread"].get("name")}
    return out


def run_codex_when(when: str, then_prompt: bool, skip_rename: bool = False) -> dict:
    cwd = Path(tempfile.mkdtemp(prefix=f"agentpane-kametu-codex-{when}-", dir="/tmp"))
    codex_home = Path(tempfile.mkdtemp(prefix=f"agentpane-kametu-codexhome-{when}-", dir="/tmp"))
    for name in ("auth.json", "config.toml"):
        src = Path.home() / ".codex" / name
        if src.exists():
            shutil.copy(src, codex_home / name)
    env = dict(os.environ, CODEX_HOME=str(codex_home))
    clock = Clock()
    p = subprocess.Popen(["codex", "-m", CODEX_MODEL, "app-server"], cwd=cwd, env=env, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    io = Lines(p)
    out: dict = {"backend": "codex", "when": when, "cwd": str(cwd), "codex_home": str(codex_home),
                 "version": subprocess.run(["codex", "--version"], capture_output=True, text=True).stdout.strip()}
    timeline: list = []
    out["timeline"] = timeline
    counter = {"n": 0}
    deltas = {"n": 0}
    ended: dict = {}

    def watch(ev):
        m = ev.get("method")
        if m == "item/agentMessage/delta":
            deltas["n"] += 1
        elif m == "thread/name/updated":
            timeline.append({"t": clock(), "notification": m, "deltas": deltas["n"], "params": ev.get("params")})
        elif m == "turn/completed":
            ended.update({"t": clock(), "deltas": deltas["n"],
                          "status": ((ev.get("params") or {}).get("turn") or {}).get("status")})

    def req(method: str, params: dict):
        counter["n"] += 1
        n = counter["n"]
        io.send({"jsonrpc": "2.0", "id": n, "method": method, "params": params})
        timeline.append({"t": clock(), "sent": method, "deltas": deltas["n"]})
        r = io.read_until(lambda e: e.get("id") == n, 120, on_other=watch)
        if r is None:
            raise SystemExit(f"no response to {method}: {p.stderr.read()[-800:]}")
        timeline.append({"t": clock(), "answered": method, "deltas": deltas["n"], "turn_ended": bool(ended),
                         "error": r.get("error")})
        return r

    # What `CodexAdapter.start()` sends for a fresh session.
    req("initialize", {"clientInfo": {"name": "agentpane-probe", "title": "session_name_probe", "version": "0"},
                       "capabilities": None})
    started = req("thread/start", {"cwd": str(cwd), "sandbox": "danger-full-access", "approvalPolicy": "never",
                                   "model": CODEX_MODEL})
    tid = started["result"]["thread"]["id"]
    out["thread_id"] = tid
    out["store_before_rename"] = codex_store(codex_home, tid)

    if when == "pre-turn":
        if skip_rename:
            out["rename_response"] = "skipped"
        else:
            r = req("thread/name/set", {"threadId": tid, "name": NAMES[0]})
            out["rename_response"] = r.get("error") or r.get("result")
        time.sleep(3)
        out["store_3s_after_rename"] = codex_store(codex_home, tid)
        out["read_name"] = (req("thread/read", {"threadId": tid}).get("result") or {}).get("thread", {}).get("name")
        listed = (req("thread/list", {"cwd": str(cwd)}).get("result") or {}).get("data", [])
        out["listed"] = [{"id": t["id"], "name": t.get("name")} for t in listed]
        if then_prompt:
            req("turn/start", {"threadId": tid, "model": CODEX_MODEL, "input": [{"type": "text", "text": PROMPT}]})
            io.read_until(lambda e: (watch(e), bool(ended))[1], 180)
            timeline.append({"turn_completed": dict(ended)})
            out["store_after_first_turn"] = codex_store(codex_home, tid)
            out["read_name_after_first_turn"] = (req("thread/read", {"threadId": tid}).get("result") or {}).get(
                "thread", {}).get("name")
    else:
        req("turn/start", {"threadId": tid, "model": CODEX_MODEL, "input": [{"type": "text", "text": LONG_PROMPT}]})
        io.read_until(lambda e: (watch(e), deltas["n"] >= DELTAS_BEFORE_RENAME or bool(ended))[1], 180)
        out["deltas_when_rename_sent"] = deltas["n"]
        out["turn_ended_before_rename"] = bool(ended)
        out["store_at_rename"] = codex_store(codex_home, tid)
        r = req("thread/name/set", {"threadId": tid, "name": NAMES[0]})
        out["rename_response"] = r.get("error") or r.get("result")
        out["deltas_when_rename_answered"] = deltas["n"]
        out["turn_ended_before_answer"] = bool(ended)
        out["store_at_rename_answer"] = codex_store(codex_home, tid)
        if not ended:
            io.read_until(lambda e: (watch(e), bool(ended))[1], 240)
        timeline.append({"turn_completed": dict(ended)})
        out["deltas_total"] = deltas["n"]
        out["read_name"] = (req("thread/read", {"threadId": tid}).get("result") or {}).get("thread", {}).get("name")
    io.close()
    timeline.append({"t": clock(), "exited": p.returncode})
    out["store_after_exit"] = codex_store(codex_home, tid)
    if when == "pre-turn":
        out["fresh_app_server"] = codex_fresh_view(cwd, env, tid)
    out["rollout_mentions_name"] = any(NAMES[0] in open(f).read() for f in out["store_after_exit"]["rollouts"])
    out["ok"] = out.get("rename_response") is not None
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=("pi", "claude", "codex"), required=True)
    ap.add_argument("--when", choices=("after-turn", "pre-turn", "mid-turn"), default="after-turn")
    ap.add_argument("--then-prompt", action="store_true",
                    help="pre-turn only: run one short turn after the rename, to see whether the name survives it")
    ap.add_argument("--skip-rename", action="store_true",
                    help="Codex pre-turn only: the control, sending no rename, to see what thread/start alone leaves")
    args = ap.parse_args()
    if args.when != "after-turn":
        if args.backend == "pi":
            ap.error("--when pre-turn|mid-turn is Claude Code and Codex only")
        if args.backend == "codex":
            out = run_codex_when(args.when, args.then_prompt, args.skip_rename)
        else:
            out = run_claude_when(args.when, args.then_prompt)
    else:
        out = {"pi": run_pi, "claude": run_claude, "codex": run_codex}[args.backend]()
    out["measured_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    json.dump(out, sys.stdout, indent=2)
    print()
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
