#!/usr/bin/env python3
"""Where does a Codex fork's rollout say its inherited history lives? (OW-buligi)

As of `codex-cli` 0.154.0 a forked rollout holds none of what it inherited: its
`session_meta` carries `history_base: {thread_id, end_ordinal_exclusive,
end_byte_offset}` and the file then holds only the fork's own records.  For a
fork of an unforked parent, the base names the parent and the ordinal is a line
count in the parent's rollout.  What was not on disk anywhere before this probe
is a fork of a fork taken *after* the first fork's own turn, the one case where
the base could name either thread and the ordinal could count either a file's
lines or the whole logical history.

The probe builds exactly that, in a temp CODEX_HOME:

  P  two turns (ONE, TWO)
  F1 = fork P keeping ONE, then two turns of its own (THREE, FOUR)
  F2 = fork F1 keeping THREE

and reports, for F1 and F2, the header's base fields, what the base's byte
offset lands on in the named file (records inside the cut are starred), and
the turns `thread/read` answers for F2.

Usage:  python3 codex_fork_history_probe.py [--json <path>]
Needs:  `codex` on PATH and readable auth under `~/.codex`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from codex_fork_same_process_probe import CLIENT_INFO, AppServer, outcome, run_turn


def last_turn_id(server: AppServer) -> str | None:
    ids = [
        event.get("params", {}).get("turn", {}).get("id")
        for event in server.notifications
        if event.get("method") == "turn/completed"
    ]
    return ids[-1] if ids else None


def rollout(codex_home: Path, thread_id: str) -> Path | None:
    return next((p for p in (codex_home / "sessions").rglob(f"*{thread_id}.jsonl")), None)


def describe(codex_home: Path, thread_id: str) -> dict[str, Any]:
    path = rollout(codex_home, thread_id)
    if path is None:
        return {"rollout": None}
    lines = path.read_text().splitlines()
    meta = json.loads(lines[0])["payload"]
    base = meta.get("history_base")
    out: dict[str, Any] = {
        "lines": len(lines),
        "forked_from_id": meta.get("forked_from_id"),
        "forked_from_ordinal_exclusive": meta.get("forked_from_ordinal_exclusive"),
        "history_base": base,
        "own_user_messages": [
            str(block.get("text"))[:60]
            for line in lines[1:]
            for rec in [json.loads(line)]
            if rec.get("type") == "response_item"
            and rec["payload"].get("type") == "message"
            and rec["payload"].get("role") == "user"
            for block in rec["payload"].get("content", [])
        ],
    }
    if base:
        base_path = rollout(codex_home, base["thread_id"])
        if base_path is not None:
            data = base_path.read_bytes()
            offset = base["end_byte_offset"]
            out["base_offset_is_line_end"] = data[offset - 1 : offset] == b"\n"
            out["base_lines_before_offset"] = data[:offset].count(b"\n")
            out["base_file_lines"] = data.count(b"\n")
            # The last few records inside the cut and the first one past it,
            # so a reader can see the cut falls at a turn's end.
            records = [json.loads(line) for line in data.decode().splitlines()]
            cut = out["base_lines_before_offset"]
            out["base_records_around_cut"] = [
                f"{n + 1}{'*' if n < cut else ' '} {rec['type']}/{rec.get('payload', {}).get('type')}"
                for n, rec in enumerate(records)
                if cut - 4 <= n <= cut
            ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", type=Path, help="write the report here as well as to stdout")
    args = ap.parse_args()

    codex_home = Path(tempfile.mkdtemp(prefix="agentpane-forkhistory-codexhome-"))
    for name in ("auth.json", "config.toml"):
        source = Path.home() / ".codex" / name
        if source.exists():
            shutil.copy2(source, codex_home / name)
    workspace = tempfile.mkdtemp(prefix="agentpane-forkhistory-work-")
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=False)
    env = dict(os.environ, CODEX_HOME=str(codex_home))

    report: dict[str, Any] = {
        "question": "what a fork of a fork's history_base names (OW-buligi)",
        "codex_version": subprocess.run(["codex", "--version"], capture_output=True, text=True).stdout.strip(),
    }
    server = AppServer(workspace, env, "server")
    try:
        server.call("initialize", {"clientInfo": CLIENT_INFO, "capabilities": None})
        parent = server.call("thread/start", {"cwd": workspace})["result"]["thread"]["id"]
        run_turn(server, parent, "Reply with exactly the word ONE and nothing else.")
        one = last_turn_id(server)
        run_turn(server, parent, "Reply with exactly the word TWO and nothing else.")

        f1 = server.call("thread/fork", {"threadId": parent, "lastTurnId": one, "cwd": workspace})["result"]["thread"]["id"]
        server.call("thread/resume", {"threadId": f1, "cwd": workspace})
        run_turn(server, f1, "Reply with exactly the word THREE and nothing else.")
        three = last_turn_id(server)
        run_turn(server, f1, "Reply with exactly the word FOUR and nothing else.")

        f2 = server.call("thread/fork", {"threadId": f1, "lastTurnId": three, "cwd": workspace})["result"]["thread"]["id"]
        read = server.call("thread/read", {"threadId": f2, "includeTurns": True})
        report["f2_thread_read_turns"] = [
            [item.get("content") for item in turn.get("items", []) if item.get("type") == "userMessage"]
            for turn in read.get("result", {}).get("thread", {}).get("turns", [])
        ] if "result" in read else outcome(read)

        report["ids"] = {"parent": parent, "f1": f1, "f2": f2}
        report["parent"] = describe(codex_home, parent)
        report["f1"] = describe(codex_home, f1)
        report["f2"] = describe(codex_home, f2)
        report["result"] = "measured"
    except Exception as exc:  # noqa: BLE001 -- the report is the product
        report["result"] = "error"
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        server.close()
        shutil.rmtree(codex_home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)

    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        args.json.write_text(text + "\n")
    return 0 if report.get("result") == "measured" else 1


if __name__ == "__main__":
    raise SystemExit(main())
