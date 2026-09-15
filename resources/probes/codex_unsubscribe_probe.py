#!/usr/bin/env python3
"""Does `thread/unsubscribe` release a thread's writer lock, and can a holder re-resume? (OW-voyezi)

OW-lajehi made a Codex fork's adapter borrow its parent's `codex app-server`,
because only the process that minted a forked thread may open it.  The child now
outlives every holder but the last, so closing one side of a fork pair no longer
releases the other side's thread: the kill used to do that, and there is no kill
while a sibling still holds the connection.  Re-attaching the closed side then
takes agentpane's factory path -- a second app-server, `thread/resume`, and
`-32600 already has an active writer`.

Two fixes were available and this probe decides between them.

`thread/unsubscribe` exists in `resources/codex-protocol/ClientRequest.ts` and
agentpane has never sent it.  If it releases the writer lock, the adapter being
disposed sends it and the factory path is correct again.  If it does not, the
re-attach has to go back to the app-server that still holds the thread and
resume it there a second time -- which is only a fix if a process CAN resume a
thread it is already holding.

So, two app-servers, one parent thread and one fork of it -- the same vehicle as
`codex_fork_same_process_probe.py`, which this is modelled on:

  CTL. Control: with the owner holding both threads, a second app-server is
       refused on the parent.  If it is NOT refused there is no lock to release
       and every other answer here is meaningless.
  R1.  Can the OWNER resume the parent a second time, holding it already?  This
       is the re-borrow fix in one request; R2 drives a turn to show the
       re-resumed thread is really drivable and not merely accepted.
  U1.  What does `thread/unsubscribe` on the parent answer the owner?
  U2.  Can the intruder resume the parent afterwards?  THIS is the question that
       chooses the fix.
  U3.  Can the owner resume the parent after unsubscribing it itself -- i.e. is
       unsubscribe at least undoable from inside?
  F1.  Does the owner still hold the fork, so unsubscribe is per-thread and not
       per-process?  Driving a turn on the fork is the check.
  F2.  The symmetric half, on the thread the owner MINTED: refused before
       unsubscribe, and after it.

Usage:  python3 codex_unsubscribe_probe.py [--json <path>]
Needs:  `codex` on PATH and readable auth under `~/.codex`.
        CODEX_HOME is a temp copy, safe here as it is in
        `codex_fork_same_process_probe.py` and is NOT in `fork_attach_probe.py`:
        nothing here consults agentpane's session index.
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
CLIENT_INFO = {"name": "agentpane-unsubscribe-probe", "version": "0", "title": "probe"}


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

    def mark(self) -> int:
        with self.lock:
            return len(self.notifications)

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

    codex_home = Path(tempfile.mkdtemp(prefix="agentpane-unsubprobe-codexhome-"))
    for name in ("auth.json", "config.toml"):
        source = Path.home() / ".codex" / name
        if source.exists():
            shutil.copy2(source, codex_home / name)
    workspace = tempfile.mkdtemp(prefix="agentpane-unsubprobe-work-")
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=False)
    env = dict(os.environ, CODEX_HOME=str(codex_home))

    report: dict[str, Any] = {
        "question": "does thread/unsubscribe release a thread's writer lock (OW-voyezi)",
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

        # One turn, so the parent is a real conversation with something on disk
        # to fork.
        report["parent_turn"] = run_turn(owner, parent_id, "Reply with exactly the word ONE and nothing else.")

        forked = owner.call("thread/fork", {"threadId": parent_id, "cwd": workspace})
        report["thread_fork"] = outcome(forked)
        fork_id = forked.get("result", {}).get("thread", {}).get("id")
        if not fork_id:
            raise RuntimeError(f"no forked thread id: {report['thread_fork']}")
        report["fork_thread"] = fork_id
        # The owner holds BOTH threads from here: this is agentpane's state after
        # a fork is attached on the borrowed connection.
        report["owner_resume_fork"] = outcome(owner.call("thread/resume", {"threadId": fork_id, "cwd": workspace}))

        intruder = AppServer(workspace, env, "intruder")
        intruder.call("initialize", {"clientInfo": CLIENT_INFO, "capabilities": None})

        # -- CTL: the lock exists and the intruder is refused by it ----------
        report["CTL_intruder_parent_before"] = outcome(
            intruder.call("thread/resume", {"threadId": parent_id, "cwd": workspace})
        )

        # -- R: can the holder open the same thread a second time? -----------
        report["R1_owner_resume_parent_again"] = outcome(
            owner.call("thread/resume", {"threadId": parent_id, "cwd": workspace})
        )
        report["R2_owner_turn_on_parent"] = run_turn(
            owner, parent_id, "Reply with exactly the word TWO and nothing else."
        )

        # -- U: unsubscribe the parent, then let the intruder in -------------
        report["U1_owner_unsubscribe_parent"] = outcome(
            owner.call("thread/unsubscribe", {"threadId": parent_id})
        )
        report["U2_intruder_parent_after"] = outcome(
            intruder.call("thread/resume", {"threadId": parent_id, "cwd": workspace})
        )
        report["U3_owner_resume_parent_after"] = outcome(
            owner.call("thread/resume", {"threadId": parent_id, "cwd": workspace})
        )

        # -- F: is unsubscribe per-thread, and does the minted thread differ? -
        report["F1_owner_turn_on_fork"] = run_turn(
            owner, fork_id, "Reply with exactly the word THREE and nothing else."
        )
        report["F2a_intruder_fork_before"] = outcome(
            intruder.call("thread/resume", {"threadId": fork_id, "cwd": workspace})
        )
        report["F2b_owner_unsubscribe_fork"] = outcome(
            owner.call("thread/unsubscribe", {"threadId": fork_id})
        )
        report["F2c_intruder_fork_after"] = outcome(
            intruder.call("thread/resume", {"threadId": fork_id, "cwd": workspace})
        )

        report["verdict"] = {
            "lock_observed": not report["CTL_intruder_parent_before"]["ok"],
            "holder_can_resume_again": report["R1_owner_resume_parent_again"]["ok"],
            "holder_can_drive_after_resuming_again": report["R2_owner_turn_on_parent"].get("completed", False),
            "unsubscribe_parent_status": (
                json.loads(report["U1_owner_unsubscribe_parent"]["result"]).get("status")
                if report["U1_owner_unsubscribe_parent"]["ok"]
                else None
            ),
            "unsubscribe_released_lock": report["U2_intruder_parent_after"]["ok"],
            "holder_can_resume_after_unsubscribing": report["U3_owner_resume_parent_after"]["ok"],
            "fork_still_drivable_by_owner": report["F1_owner_turn_on_fork"].get("completed", False),
            "fork_locked_before_unsubscribe": not report["F2a_intruder_fork_before"]["ok"],
            "fork_released_by_unsubscribe": report["F2c_intruder_fork_after"]["ok"],
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
