#!/usr/bin/env python3
"""Can the app-server that minted a fork also drive it? (OW-lajehi)

`fork_attach_probe.py` measured the half agentpane already suffers: a SECOND
`codex app-server` process cannot open a thread the first one holds, so the
attach after `POST .../fork` fails with "already has an active writer".
This probe asks the question that decides the fix, and it asks it of the CLI
directly, with no agentpane in the picture.

Three questions, in one process, on one JSON-RPC client:

  A. Does `thread/resume` on the freshly forked thread succeed HERE, in the
     process that minted it and holds its writer lock?
  B. Does `turn/start` against the forked thread id work -- with the resume if
     A succeeded, and without one if A failed?
  C. Is the parent thread still drivable afterwards, or does visiting the fork
     cost the process its grip on the parent?

Plus the control that ties this back to the agentpane run: a second
`codex app-server`, started while the first still lives, asked to resume the
same fork.  It should be refused, and the refusal should carry the writer-lock
text; if it is NOT refused, the whole diagnosis is wrong and that matters more
than anything else here.

If A or B says yes, the fork can be driven by the parent's client and OW-lajehi
has a fix that leaves D15 alone.  If both say no, the cheap option in that card
(dispose the parent at fork time) is the only one left standing locally.

Usage:  python3 codex_fork_same_process_probe.py [--json <path>]
Needs:  `codex` on PATH and readable auth under `~/.codex`.
        CODEX_HOME is a temp copy, which is safe here in a way it is NOT for
        `fork_attach_probe.py`: nothing in this probe consults agentpane's
        session index, so moving the store moves nothing out from under it.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

# The home server pins Codex to one model for agent-driven turns (AGENTS.md,
# "Evidence"); app-server takes no flag, so the pin rides on every turn/start.
MODEL = "gpt-5.6-luna"
CLIENT_INFO = {"name": "agentpane-fork-probe", "version": "0", "title": "probe"}


class AppServer:
    """One `codex app-server` child and a request/response correlator over it."""

    def __init__(self, cwd: str, env: dict[str, str], label: str) -> None:
        self.label = label
        self.proc = subprocess.Popen(
            ["codex", "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=cwd,
            env=env,
        )
        self.lock = threading.Lock()
        self.responses: dict[int, dict[str, Any]] = {}
        self.notifications: list[dict[str, Any]] = []
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for line in self.proc.stdout:  # type: ignore[union-attr]
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            with self.lock:
                if isinstance(event.get("id"), int) and ("result" in event or "error" in event):
                    self.responses[event["id"]] = event
                elif "method" in event:
                    self.notifications.append(event)

    def call(self, method: str, params: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
        """Send a request and return its response verbatim -- error included.

        An error is an answer here, not a failure: every question this probe
        asks is answered by which of `result` and `error` comes back.
        """
        with self.lock:
            self.next_id += 1
            request_id = self.next_id
        self.proc.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")  # type: ignore[union-attr]
        self.proc.stdin.flush()  # type: ignore[union-attr]
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if request_id in self.responses:
                    return self.responses.pop(request_id)
            if self.proc.poll() is not None:
                return {"error": {"message": f"{self.label}: app-server exited ({self.proc.returncode})"}}
            time.sleep(0.05)
        return {"error": {"message": f"{self.label}: no response to {method} in {timeout}s"}}

    def wait_for_turn_end(self, timeout: float = 120.0) -> dict[str, Any] | None:
        """The next `turn/completed`, with its turn id, or None if none arrives."""
        seen = len(self.notifications)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                for event in self.notifications[seen:]:
                    if event.get("method") == "turn/completed":
                        return event.get("params", {})
            time.sleep(0.05)
        return None

    def agent_text_since(self, index: int) -> str:
        with self.lock:
            events = self.notifications[index:]
        out = []
        for event in events:
            if event.get("method") != "item/completed":
                continue
            item = event.get("params", {}).get("item", {})
            if item.get("type") == "agentMessage":
                out.append(item.get("text", ""))
        return " | ".join(out)[:200]

    def mark(self) -> int:
        with self.lock:
            return len(self.notifications)

    def close(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def outcome(response: dict[str, Any]) -> dict[str, Any]:
    """A response reduced to what this probe reports: did it work, and what did it say."""
    if "error" in response:
        return {"ok": False, "error": str(response["error"])[:300]}
    return {"ok": True, "result": json.dumps(response.get("result", {}))[:300]}


def run_turn(server: AppServer, thread_id: str, text: str) -> dict[str, Any]:
    """One turn, reported by its response, its completion, and its reply."""
    mark = server.mark()
    response = server.call(
        "turn/start",
        {"threadId": thread_id, "model": MODEL, "input": [{"type": "text", "text": text}]},
    )
    record = {"turn_start": outcome(response)}
    if not record["turn_start"]["ok"]:
        return record
    completed = server.wait_for_turn_end()
    record["completed"] = bool(completed)
    record["status"] = (completed or {}).get("turn", {}).get("status")
    record["reply"] = server.agent_text_since(mark)
    return record


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", type=Path, help="write the report here as well as to stdout")
    args = ap.parse_args()

    codex_home = Path(tempfile.mkdtemp(prefix="agentpane-forkprobe-codexhome-"))
    for name in ("auth.json", "config.toml"):
        source = Path.home() / ".codex" / name
        if source.exists():
            shutil.copy2(source, codex_home / name)
    workspace = tempfile.mkdtemp(prefix="agentpane-forkprobe-work-")
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=False)
    env = dict(os.environ, CODEX_HOME=str(codex_home))

    report: dict[str, Any] = {
        "question": "can the app-server that minted a fork also drive it (OW-lajehi)",
        "codex_version": subprocess.run(["codex", "--version"], capture_output=True, text=True).stdout.strip(),
        "model": MODEL,
        "workspace": workspace,
    }
    owner = AppServer(workspace, env, "owner")
    intruder: AppServer | None = None
    try:
        report["initialize"] = outcome(owner.call("initialize", {"clientInfo": CLIENT_INFO, "capabilities": None}))
        started = owner.call("thread/start", {"cwd": workspace})
        report["thread_start"] = outcome(started)
        parent_id = started.get("result", {}).get("thread", {}).get("id")
        if not parent_id:
            raise RuntimeError(f"no parent thread id: {report['thread_start']}")
        report["parent_thread"] = parent_id

        # Two turns, so the fork has a turn to keep and a turn to drop -- the
        # same shape the adapter's `lastTurnId` arithmetic addresses.
        report["parent_turn_one"] = run_turn(owner, parent_id, "Reply with exactly the word ONE and nothing else.")
        first_turn_id = None
        for event in owner.notifications:
            if event.get("method") == "turn/completed":
                first_turn_id = event.get("params", {}).get("turn", {}).get("id")
                break
        report["first_turn_id"] = first_turn_id
        report["parent_turn_two"] = run_turn(owner, parent_id, "Reply with exactly the word TWO and nothing else.")

        # `lastTurnId` is inclusive, so keeping the first turn is what forking
        # AT the second user message means (`codex/adapter.ts` `fork`).
        forked = owner.call(
            "thread/fork",
            {"threadId": parent_id, **({"lastTurnId": first_turn_id} if first_turn_id else {}), "cwd": workspace},
        )
        report["thread_fork"] = outcome(forked)
        fork_id = forked.get("result", {}).get("thread", {}).get("id")
        if not fork_id:
            raise RuntimeError(f"no forked thread id: {report['thread_fork']}")
        report["fork_thread"] = fork_id

        # -- the control, first, because everything else rests on it ---------
        intruder = AppServer(workspace, env, "intruder")
        intruder.call("initialize", {"clientInfo": CLIENT_INFO, "capabilities": None})
        report["B0_second_process_resume"] = outcome(
            intruder.call("thread/resume", {"threadId": fork_id, "cwd": workspace})
        )

        # -- A: resume the fork in the process that minted it ---------------
        report["A_same_process_resume"] = outcome(
            owner.call("thread/resume", {"threadId": fork_id, "cwd": workspace})
        )

        # -- B: drive a turn on the fork from that same process -------------
        report["B_same_process_turn"] = run_turn(
            owner, fork_id, "Reply with exactly the word THREE and nothing else."
        )

        # -- C: is the parent still drivable afterwards? ---------------------
        report["C_parent_after_fork_visit"] = run_turn(
            owner, parent_id, "Reply with exactly the word FOUR and nothing else."
        )

        report["verdict"] = {
            "second_process_refused": not report["B0_second_process_resume"]["ok"],
            "same_process_resume_ok": report["A_same_process_resume"]["ok"],
            "same_process_turn_ok": report["B_same_process_turn"].get("completed", False),
            "parent_still_drivable": report["C_parent_after_fork_visit"].get("completed", False),
        }
        report["result"] = "measured"
    except Exception as exc:  # noqa: BLE001 -- the report is the product
        report["result"] = "error"
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        owner.close()
        if intruder is not None:
            intruder.close()
        shutil.rmtree(codex_home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)

    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        args.json.write_text(text + "\n")
    return 0 if report.get("result") == "measured" else 1


if __name__ == "__main__":
    raise SystemExit(main())
