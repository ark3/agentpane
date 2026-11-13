#!/usr/bin/env python3
"""A separate process that holds no token can create and attach a session.

What it proves: any process that can reach agentpane's loopback port gets the
whole API. Acting as a non-browser client -- no `Authorization`, no `Origin`,
no `Sec-Fetch-Site` -- it creates a Pi session (`POST /api/sessions`) whose
`cwd` is a fresh directory it was never given by anyone, then attaches to it
(`GET` of the session route), which spawns the agent there. A sandboxed agent
shares the host's loopback (`sbox` keeps the network), so it can do the same.

Its passing condition is refusal: it **passes** (exit 0) only when the server
answers both requests 401 or 403. It **fails** (exit 1), meaning the exposure
reproduced, when either answers 2xx. Any other answer -- a 400, a 404, a 5xx
from an attach whose Pi could not start, a connection error -- is
**inconclusive** (exit 2): it shows neither refusal nor access. Exit 3 means
the verdict stands but the run could not close the session it attached or
clean up after itself, which a run must not do silently.

Two modes:

* **Default.** Builds the client (unless `--skip-build`) and starts its own
  production server from this checkout, the way `agentpane_pi_smoke.py`
  does, on a port the OS picks, with Pi given a throwaway state directory
  through `PI_CODING_AGENT_DIR`. The server is stopped at the end.
* **`--base-url URL`.** Starts no server and targets one already running,
  for instance a server started outside `sbox` while this probe runs inside
  it. The workspace is under `/var/tmp`, which `sbox` binds read-write from
  the host, so a server outside the probe's sandbox sees the same directory.

The workspace is a fresh directory under `/var/tmp` holding an empty
`.sandbox-workspace`, because `sbox` refuses as a workspace a directory with
neither a marker file nor a git root, and an attach whose agent exits at once
would be inconclusive. If an attach succeeds the probe closes that session
(`DELETE` on the ref the attach answered, which may differ from the one in the
URL) so no agent is left running.

The create carries the pinned `model`, as `agentpane_pi_smoke.py` sends, but
the probe never prompts, so no model is charged.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from agentpane_live_support import (
    Http,
    build_client,
    descendants,
    finalize,
    make_state_home,
    now,
    ref_path,
    start_server,
    wait_for_built_client,
)
from agentpane_pi_smoke import PI_STATE_FILES, PINNED_MODEL, pi_workers

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"

EXIT_PASS = 0
EXIT_REPRODUCED = 1
EXIT_INCONCLUSIVE = 2
EXIT_CLEANUP_FAILED = 3

# Attached only when the create was not answered with a ref, so the attach is
# still asked: with a token required it is refused before any lookup, and
# without one it is an unknown session, which is inconclusive.
PLACEHOLDER_REF = {"backend": "pi", "id": "virtual:loopback-token-repro-probe"}


def free_port() -> int:
    """A port the OS has just handed out. It is released before the server
    binds it, so another process could take it in between; the server would
    then fail to start, and the run says so."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def make_workspace() -> Path:
    workspace = Path(tempfile.mkdtemp(prefix="agentpane-loopback-ws-", dir="/var/tmp"))
    (workspace / ".sandbox-workspace").touch()
    return workspace


def call(http: Http, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """One request, sent with no token and no browser metadata, and its whole answer.

    `Http.request` adds only `content-type` for a body; `http.client` adds
    `Host` and `Accept-Encoding`, and nothing else.
    """
    status, raw = http.request(method, path, body)
    text = raw.decode(errors="replace")
    try:
        parsed: Any = json.loads(text) if text else None
    except json.JSONDecodeError:
        parsed = text
    return {"at": now(), "method": method, "path": path, "request_body": body, "status": status, "body": parsed}


def classify(create: int | None, attach: int | None) -> tuple[str, int]:
    def allowed(status: int | None) -> bool:
        return status is not None and 200 <= status < 300

    def refused(status: int | None) -> bool:
        return status in (401, 403)

    if allowed(create) or allowed(attach):
        return "fails: the exposure reproduced", EXIT_REPRODUCED
    if refused(create) and refused(attach):
        return "passes: both refused", EXIT_PASS
    return "inconclusive", EXIT_INCONCLUSIVE


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--base-url",
        default=None,
        help="target a server already running at this http URL instead of starting one",
    )
    parser.add_argument(
        "--app-root",
        type=Path,
        default=REPO,
        help="agentpane checkout to build and serve when starting a server (default: derived from this script)",
    )
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing dist/client bundle")
    parser.add_argument(
        "--credential-source",
        type=Path,
        default=Path.home() / ".pi" / "agent",
        help="directory holding Pi's auth and model state, copied by name and never printed",
    )
    parser.add_argument(
        "--model",
        default=PINNED_MODEL,
        help="model ref sent on create (default: the model AGENTS.md pins)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = make_workspace()
    evidence: dict[str, Any] = {
        "started_at": now(),
        "mode": "base-url" if args.base_url else "own server",
        "workspace": str(workspace),
        "model_flag": args.model,
        "headers_sent": "none beyond what http.client adds (Host, Accept-Encoding) and content-type on a body",
        "requests": [],
    }

    server: subprocess.Popen[bytes] | None = None
    state_home: Path | None = None
    server_log: Path | None = None
    launched_workers: set[int] = set()
    create_status: int | None = None
    attach_status: int | None = None
    close_ok = True

    try:
        if args.base_url:
            parts = urlsplit(args.base_url)
            if parts.scheme != "http" or not parts.hostname or parts.port is None:
                raise RuntimeError(f"--base-url must be http://host:port, got {args.base_url!r}")
            http = Http(parts.hostname, parts.port)
            evidence["target"] = f"http://{parts.hostname}:{parts.port}"
        else:
            repo = args.app_root.expanduser().resolve()
            if not (repo / "package.json").is_file():
                raise RuntimeError(f"not an agentpane checkout: {repo}")
            port = free_port()
            http = Http(HOST, port)
            evidence["target"] = f"http://{HOST}:{port}"
            state_home, copied = make_state_home(
                args.credential_source.expanduser().resolve(), PI_STATE_FILES, "agentpane-loopback-pihome-"
            )
            evidence["pi_state"] = {"temporary_state_home": str(state_home), "copied_files": copied}
            if "auth.json" not in copied:
                raise RuntimeError(f"missing Pi credentials under {args.credential_source}")
            evidence["pi_version"] = subprocess.run(
                ["pi", "--version"], capture_output=True, text=True, check=True
            ).stdout.strip()
            if not args.skip_build:
                evidence["build"] = build_client(repo)
            server_log = Path(tempfile.mkstemp(prefix="agentpane-loopback-server-", suffix=".log")[1])
            server = start_server(
                repo, dict(os.environ, PI_CODING_AGENT_DIR=str(state_home), PORT=str(port)), server_log
            )
            evidence["server_pid"] = server.pid
            wait_for_built_client(http, server, 20)

        create = call(http, "POST", "/api/sessions", {"cwd": str(workspace), "backend": "pi", "model": args.model})
        evidence["requests"].append(create)
        create_status = create["status"]

        created_ref = create["body"].get("ref") if isinstance(create["body"], dict) else None
        target_ref = created_ref if isinstance(created_ref, dict) else PLACEHOLDER_REF
        attach = call(http, "GET", ref_path(target_ref))
        evidence["requests"].append(attach)
        attach_status = attach["status"]

        if 200 <= attach_status < 300:
            # The attach's own ref, not the URL's: attaching is where a session
            # first adopts its backend's id, and `summary.ref` is authoritative.
            session = attach["body"].get("session", {}) if isinstance(attach["body"], dict) else {}
            attached_ref = session.get("ref")
            if not isinstance(attached_ref, dict):
                close_ok = False
                evidence["close_error"] = "the attach answered no session.ref, so the session was not closed"
            else:
                close_ok = False
                # Only a server this run started is a tree it may inspect, so
                # in --base-url mode the DELETE's 204 is the whole evidence.
                if server is not None:
                    attached_pids = {row["pid"] for row in pi_workers(descendants(server.pid))}
                    launched_workers.update(attached_pids)
                    evidence["pi_pids_after_attach"] = sorted(attached_pids)
                close = call(http, "DELETE", ref_path(attached_ref))
                evidence["requests"].append(close)
                close_ok = close["status"] == 204
                if server is not None:
                    deadline = time.monotonic() + 10
                    alive = sorted(pid for pid in launched_workers if Path(f"/proc/{pid}").exists())
                    while alive and time.monotonic() < deadline:
                        time.sleep(0.1)
                        alive = sorted(pid for pid in launched_workers if Path(f"/proc/{pid}").exists())
                    evidence["pi_pids_alive_after_close"] = alive
                    close_ok = close_ok and not alive
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
        if server_log is not None and server_log.exists():
            evidence["server_log_tail"] = server_log.read_text(errors="replace")[-4000:]

    verdict, exit_code = classify(create_status, attach_status)
    evidence["verdict"] = verdict
    evidence["statuses"] = {"create": create_status, "attach": attach_status}

    cleanup_ok = close_ok
    if server is not None and state_home is not None and server_log is not None:
        # `finalize` only rewrites a `result` key, which this probe does not
        # use: its verdict is not pass/fail in the smoke probes' sense.
        finalize(
            evidence,
            exit_code,
            server=server,
            streams=[],
            state_home=state_home,
            server_log=server_log,
            launched_workers=launched_workers,
            worker_filter=pi_workers,
        )
        cleanup_ok = cleanup_ok and evidence["cleanup"]["result"] == "pass"
    else:
        if state_home is not None:
            shutil.rmtree(state_home, ignore_errors=True)
        if server_log is not None:
            server_log.unlink(missing_ok=True)
    shutil.rmtree(workspace, ignore_errors=True)
    evidence["workspace_removed"] = not workspace.exists()
    cleanup_ok = cleanup_ok and evidence["workspace_removed"]
    evidence["session_closed_and_cleaned_up"] = cleanup_ok
    evidence["finished_at"] = now()

    print(json.dumps(evidence, indent=2))
    print(f"\ncreate: HTTP {create_status}; attach: HTTP {attach_status}; {verdict}")
    if not cleanup_ok:
        print("cleanup did not complete; see close_error, requests and cleanup above")
        return EXIT_CLEANUP_FAILED
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
