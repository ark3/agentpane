#!/usr/bin/env python3
"""What Pi does with a stop sent while nothing runs, and with a fork after it
(ark3/agentpane#47).

`PiAdapter.fork` stops the session before every fork, a running turn or not,
the way `PiAdapter.abort` stops it: `clear_queue`, then `abort`. This
measures that path on an idle session.

`pi --mode rpc --session-dir <scratch>/sessions --model <pinned>`, read raw
through `PiRpc` from `agentpane_pi_prompt_window_probe.py`, with a throwaway
`PI_CODING_AGENT_DIR` holding copies of the owner's state files:

* one short turn, until Pi settles;
* `get_fork_messages`, then `clear_queue` and `abort` with nothing running,
  each answer recorded with every line Pi wrote between the `clear_queue`
  and a quiet period after the `abort`'s answer;
* `fork` at the first user message, then `get_state`.

Prints one JSON object. `result` is `pass` when both stop commands succeed,
the stop emits nothing but their two responses and a `queue_update` naming
empty queues (which `reduce` in `src/server/adapters/pi/reducer.ts` returns
unchanged state for, so no client hears of it), and the fork after it
succeeds and moves `sessionFile`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from agentpane_pi_prompt_window_probe import PINNED_MODEL, PiRpc, make_pi_home, make_workspace, word

QUIET_AFTER_STOP = 2.0


def command(rpc: PiRpc, payload: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    start = len(rpc.snapshot())
    rpc.write(payload)
    return rpc.wait(rpc.response(start, payload["id"]), timeout, payload["type"])["event"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", default=PINNED_MODEL)
    parser.add_argument("--pi", default=shutil.which("pi") or "pi")
    args = parser.parse_args()

    home, copied, _extensions = make_pi_home(Path.home() / ".pi" / "agent")
    workspace = make_workspace()
    sessions = workspace / "sessions"
    rpc = PiRpc(args.pi, args.model, home, workspace, ("--session-dir", str(sessions)))
    report: dict[str, Any] = {"model_flag": args.model, "state_files_copied": copied}
    try:
        report["pi_version"] = subprocess.run([args.pi, "--version"], capture_output=True, text=True).stdout.strip()
        report["model"] = command(rpc, {"id": "v", "type": "get_state"})["data"].get("model", {}).get("id")
        start = len(rpc.snapshot())
        rpc.write({"id": "p1", "type": "prompt", "message": word("ALPHA")})
        rpc.wait(rpc.response(start, "p1"), 30, "prompt")
        report["settled"] = rpc.settle(start)

        points = command(rpc, {"id": "fm", "type": "get_fork_messages"})
        report["fork_messages"] = points["data"]["messages"]
        before = command(rpc, {"id": "s0", "type": "get_state"})["data"]
        report["before_stop"] = {"isStreaming": before["isStreaming"], "sessionFile": before.get("sessionFile")}

        mark = len(rpc.snapshot())
        report["clear_queue"] = command(rpc, {"id": "cq", "type": "clear_queue"})
        report["abort"] = command(rpc, {"id": "ab", "type": "abort"})
        time.sleep(QUIET_AFTER_STOP)
        stop_lines = [row["event"] for row in rpc.snapshot()[mark:]]
        report["stop_lines"] = [
            {k: e[k] for k in ("type", "command", "success", "steering", "followUp") if k in e} for e in stop_lines
        ]

        entry_id = report["fork_messages"][0]["entryId"]
        report["fork"] = command(rpc, {"id": "fk", "type": "fork", "entryId": entry_id})
        after = command(rpc, {"id": "s1", "type": "get_state"})["data"]
        report["after_fork"] = {"isStreaming": after["isStreaming"], "sessionFile": after.get("sessionFile")}

        responses = [e for e in stop_lines if e.get("type") == "response"]
        others = [e for e in stop_lines if e.get("type") != "response"]
        quiet_stop = len(responses) == 2 and all(
            e.get("type") == "queue_update" and not e.get("steering") and not e.get("followUp") for e in others
        )
        passed = (
            report["clear_queue"].get("success") is True
            and report["abort"].get("success") is True
            and quiet_stop
            and report["fork"].get("success") is True
            and not report["fork"].get("data", {}).get("cancelled")
            and report["after_fork"]["sessionFile"] != report["before_stop"]["sessionFile"]
        )
        report["result"] = "pass" if passed else "fail"
    except Exception as error:  # noqa: BLE001 -- a probe reports, it does not crash
        report["result"] = "fail"
        report["error"] = repr(error)
    finally:
        rpc.close()
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)
    print(json.dumps(report, indent=1))
    return 0 if report["result"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
