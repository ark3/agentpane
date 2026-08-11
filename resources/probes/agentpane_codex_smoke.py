#!/usr/bin/env python3
"""One-shot live Codex smoke check through agentpane's production HTTP/SSE server.

This makes real model calls. It never invokes Pi and never prints credential
contents. Process inspection is scoped to the server tree this run launched:
finding descendants reads one parent link per process, and command lines are
read only for pids already established as descendants. The only processes it
ever signals are that server and the Codex workers it was seen to own.
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable


REPO = Path(__file__).resolve().parents[2]
WORKSPACE = str(REPO)
REAL_CODEX_HOME = Path.home() / ".codex"
PORT = 44173
HOST = "127.0.0.1"


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="milliseconds")


def request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection(HOST, PORT, timeout=60)
    payload = None if body is None else json.dumps(body).encode()
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers["content-type"] = "application/json"
    conn.request(method, path, body=payload, headers=request_headers)
    response = conn.getresponse()
    data = response.read()
    status = response.status
    conn.close()
    return status, data


def json_request(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    status, raw = request(method, path, body)
    return status, json.loads(raw) if raw else None


def ppid_of(pid: int) -> int | None:
    """This process's parent, and nothing else about it.

    `/proc/<pid>/stat` is `pid (comm) state ppid ...`, and `comm` may contain
    both spaces and parentheses. Splitting the whole line on whitespace and
    taking field 3 therefore misreads the parent of any process whose name has
    a space in it -- which either hides a real descendant of this run or
    attributes an unrelated process to it. Parse after the final `)`.
    """
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rindex(")") + 1 :].split()
        return int(fields[1])
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, IndexError):
        return None


def descendants(root: int) -> list[dict[str, Any]]:
    """Live descendants of `root`, with command lines read for those alone.

    Finding children costs one parent link per process, because that is the
    only way Linux answers "who are my descendants". Nothing else about an
    unrelated process is opened: `comm` and `cmdline` are read after the tree
    is known, so no command line outside this run's own server tree is ever
    read, let alone recorded.
    """
    links: dict[int, int] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        parent = ppid_of(pid)
        if parent is not None:
            links[pid] = parent

    children: dict[int, list[int]] = {}
    for pid, parent in links.items():
        children.setdefault(parent, []).append(pid)

    found: list[int] = []
    seen: set[int] = {root}
    frontier = [root]
    while frontier:
        for child in children.get(frontier.pop(), []):
            if child in seen:
                continue
            seen.add(child)
            found.append(child)
            frontier.append(child)

    rows: list[dict[str, Any]] = []
    for pid in sorted(found):
        try:
            comm = Path(f"/proc/{pid}/comm").read_text().strip()
            cmd = (
                Path(f"/proc/{pid}/cmdline")
                .read_bytes()
                .replace(b"\0", b" ")
                .decode(errors="replace")
                .strip()
            )
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue  # exited while we walked; it is not a survivor either way
        rows.append({"pid": pid, "ppid": links[pid], "comm": comm, "cmd": cmd})
    return rows


def reap(pids: set[int], grace: float) -> list[int]:
    """Wait out this run's own Codex workers, then kill whatever is left.

    Every pid here was recorded while it was a descendant of the server this
    run launched. That is an identity at the time of observation, not a
    guarantee at the time of signalling: after the wait below, a pid the
    kernel has recycled would belong to something else. The window is small
    and this is a developer probe, but the claim is "signals only pids that
    were ours", not "cannot possibly signal anything else".

    A harness that quietly leaves a sandboxed agent running is worse than one
    that reports the leak, so survivors are both killed and returned.
    """
    deadline = time.monotonic() + grace
    alive = sorted(pid for pid in pids if Path(f"/proc/{pid}").exists())
    while alive and time.monotonic() < deadline:
        time.sleep(0.1)
        alive = sorted(pid for pid in pids if Path(f"/proc/{pid}").exists())
    for pid in alive:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return alive


def codex_workers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The npm launcher is a Node process whose argv also says `app-server`;
    # it starts one native binary named `codex`. Count that leaf worker while
    # retaining the complete launcher tree separately as evidence.
    return [row for row in rows if row["comm"] == "codex" and "app-server" in row["cmd"]]


class SseReader:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._conn: http.client.HTTPConnection | None = None
        self._response: http.client.HTTPResponse | None = None
        self._closing = False
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()
        if not self._ready.wait(10):
            raise TimeoutError("SSE connection did not open")

    def _run(self) -> None:
        try:
            self._conn = http.client.HTTPConnection(HOST, PORT, timeout=120)
            self._conn.request("GET", "/api/events")
            self._response = self._conn.getresponse()
            if self._response.status != 200:
                raise RuntimeError(f"SSE returned HTTP {self._response.status}")
            self._ready.set()
            try:
                while True:
                    raw = self._response.readline()
                    if not raw:
                        return
                    line = raw.decode(errors="replace").rstrip("\r\n")
                    if not line.startswith("data: "):
                        continue
                    event = json.loads(line[6:])
                    with self._lock:
                        self.events.append((now(), event))
            except (AttributeError, OSError, http.client.HTTPException):
                if not self._closing:
                    raise
        finally:
            self._ready.set()

    def snapshot(self) -> list[tuple[str, dict[str, Any]]]:
        with self._lock:
            return list(self.events)

    def wait_for(
        self,
        predicate: Callable[[list[tuple[str, dict[str, Any]]]], Any],
        timeout: float,
        label: str,
    ) -> Any:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            events = self.snapshot()
            value = predicate(events)
            if value:
                return value
            time.sleep(0.05)
        raise TimeoutError(f"timed out waiting for {label}; saw {len(self.snapshot())} events")

    def close(self) -> None:
        self._closing = True
        if self._response is not None:
            self._response.close()
        if self._conn is not None:
            self._conn.close()
        self._thread.join(timeout=2)


def ref_path(ref: dict[str, str], suffix: str = "") -> str:
    from urllib.parse import quote

    return f"/api/sessions/{ref['backend']}/{quote(ref['id'], safe='')}{suffix}"


def assistant_text(message: dict[str, Any]) -> str:
    if message.get("role") != "assistant":
        return ""
    return "".join(
        block.get("text", "")
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


def streaming_value(event: dict[str, Any], ref: dict[str, str]) -> bool | None:
    if event.get("session") != ref or event.get("type") not in ("snapshot", "status"):
        return None
    value = event.get("isStreaming")
    return value if isinstance(value, bool) else None


def last_streaming(events: list[tuple[str, dict[str, Any]]], ref: dict[str, str]) -> bool | None:
    """The most recent streaming state this session was reported to be in."""
    for _, event in reversed(events):
        value = streaming_value(event, ref)
        if value is not None:
            return value
    return None


def max_assistant_length(events: list[tuple[str, dict[str, Any]]], ref: dict[str, str]) -> int:
    """Longest assistant text seen for this session, across upserts and snapshots."""
    longest = 0
    for _, event in events:
        if event.get("session") != ref:
            continue
        if event.get("type") == "upsert":
            longest = max(longest, len(assistant_text(event.get("message", {}))))
        elif event.get("type") == "snapshot":
            for message in event.get("messages", []):
                longest = max(longest, len(assistant_text(message)))
    return longest


def process_evidence(server_pid: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tree = descendants(server_pid)
    workers = codex_workers(tree)
    compact = [
        {"pid": row["pid"], "ppid": row["ppid"], "comm": row["comm"], "argv0": row["cmd"].split(" ", 1)[0]}
        for row in tree
    ]
    return compact, workers


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app-root",
        type=Path,
        default=REPO,
        help="agentpane checkout to build and serve (default: derived from this script)",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=None,
        help="workspace for the new Codex session (default: app root)",
    )
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--credential-source",
        type=Path,
        default=REAL_CODEX_HOME,
        help="directory containing auth.json/config.toml (contents are never printed)",
    )
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing dist/client bundle")
    return parser.parse_args()


def main() -> int:
    global REPO, WORKSPACE, PORT, REAL_CODEX_HOME
    args = parse_args()
    REPO = args.app_root.expanduser().resolve()
    workspace = (args.workspace or REPO).expanduser().resolve()
    WORKSPACE = str(workspace)
    PORT = args.port
    REAL_CODEX_HOME = args.credential_source.expanduser().resolve()

    state_home = Path(
        tempfile.mkdtemp(prefix="agentpane-live-codexhome-", dir="/var/tmp")
    )
    server_log = Path(tempfile.mkstemp(prefix="agentpane-live-server-", suffix=".log")[1])
    server: subprocess.Popen[bytes] | None = None
    streams: list[SseReader] = []
    launched_workers: set[int] = set()
    evidence: dict[str, Any] = {
        "started_at": now(),
        "workspace": WORKSPACE,
        "codex_version": subprocess.run(["codex", "--version"], capture_output=True, text=True, check=True).stdout.strip(),
        "transport_level": "built client reachability plus production REST/SSE; no browser automation",
        "temporary_codex_home": str(state_home),
        "checks": {},
    }
    try:
        if not REPO.is_dir() or not (REPO / "package.json").is_file():
            raise RuntimeError(f"not an agentpane checkout: {REPO}")
        if not workspace.is_dir():
            raise RuntimeError(f"workspace does not exist: {workspace}")

        copied: list[str] = []
        for name in ("auth.json", "config.toml"):
            source = REAL_CODEX_HOME / name
            if source.exists():
                shutil.copy2(source, state_home / name)
                copied.append(name)
        evidence["copied_credential_files"] = copied
        if "auth.json" not in copied:
            raise RuntimeError(f"missing Codex credentials under {REAL_CODEX_HOME}")

        if not args.skip_build:
            built = subprocess.run(
                ["bun", "run", "build"],
                cwd=REPO,
                capture_output=True,
                text=True,
                timeout=120,
            )
            evidence["build"] = {"returncode": built.returncode}
            if built.returncode != 0:
                raise RuntimeError(f"client build failed: {(built.stdout + built.stderr)[-2000:]}")

        log_handle = server_log.open("wb")
        env = dict(os.environ, CODEX_HOME=str(state_home), PORT=str(PORT))
        server = subprocess.Popen(
            ["bun", "run", "start"],
            cwd=REPO,
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log_handle.close()
        evidence["server_pid"] = server.pid

        deadline = time.monotonic() + 20
        static_status = 0
        static_body = b""
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(f"server exited during startup with {server.returncode}")
            try:
                static_status, static_body = request("GET", "/", headers={"accept": "text/html"})
                if static_status == 200:
                    break
            except OSError:
                pass
            time.sleep(0.1)
        if static_status != 200:
            raise RuntimeError("built client was not reachable")
        evidence["built_client"] = {
            "timestamp": now(),
            "http_status": static_status,
            "has_app_mount": b'id="app"' in static_body,
        }

        stream = SseReader()
        stream.start()
        streams.append(stream)

        create_status, created = json_request(
            "POST", "/api/sessions", {"cwd": WORKSPACE, "backend": "codex"}
        )
        if create_status != 201:
            raise RuntimeError(f"create failed: HTTP {create_status} {created}")
        virtual_ref = created["ref"]

        attach_status, attached = json_request("GET", ref_path(virtual_ref))
        if attach_status != 200:
            raise RuntimeError(f"attach failed: HTTP {attach_status} {attached}")
        real_ref = attached["session"]["ref"]
        if real_ref["backend"] != "codex" or real_ref["id"].startswith("virtual:"):
            raise RuntimeError(f"attach did not adopt a Codex thread id: {real_ref}")

        tree, workers = process_evidence(server.pid)
        evidence["initial_process_tree"] = tree
        evidence["initial_app_server_candidates"] = [
            {"pid": row["pid"], "ppid": row["ppid"], "comm": row["comm"], "cmd": row["cmd"]}
            for row in workers
        ]
        launched_workers.update(row["pid"] for row in workers)
        if len(workers) != 1:
            raise RuntimeError(f"expected one Codex app-server descendant, found {len(workers)}")
        evidence["checks"]["create"] = {
            "timestamp": now(),
            "result": "pass",
            "http": [create_status, attach_status],
            "virtual_id_adopted": True,
            "process_tree": tree,
            "codex_worker_pids": sorted(launched_workers),
        }

        first_start = len(stream.snapshot())
        prompt_status, prompt_body = json_request(
            "POST",
            ref_path(real_ref, "/prompt"),
            {
                "text": "Do not use tools. Write one sentence of at least 120 words explaining why deterministic tests are useful."
            },
        )
        if prompt_status != 202:
            raise RuntimeError(f"prompt failed: HTTP {prompt_status} {prompt_body}")

        def growing(events: list[tuple[str, dict[str, Any]]]) -> Any:
            lengths_by_index: dict[int, list[int]] = {}
            for stamp, event in events[first_start:]:
                if event.get("type") != "upsert" or event.get("session") != real_ref:
                    continue
                text = assistant_text(event.get("message", {}))
                if text:
                    lengths_by_index.setdefault(event.get("index", -1), []).append(len(text))
            for index, lengths in lengths_by_index.items():
                distinct = sorted(set(lengths))
                if len(distinct) >= 2 and distinct[-1] > distinct[0]:
                    return {"index": index, "updates": len(lengths), "distinct_lengths": len(distinct), "first": distinct[0], "last": distinct[-1]}
            return None

        growth = stream.wait_for(growing, 90, "incremental assistant transcript updates")

        def idle_after_streaming(events: list[tuple[str, dict[str, Any]]]) -> Any:
            saw_true = False
            true_at = None
            for stamp, event in events[first_start:]:
                value = streaming_value(event, real_ref)
                if value is True:
                    saw_true = True
                    true_at = stamp
                if saw_true and value is False:
                    return {
                        "streaming_at": true_at,
                        "idle_at": stamp,
                        "idle_event_type": event.get("type"),
                    }
            return None

        idle = stream.wait_for(idle_after_streaming, 180, "streaming state to return to idle")
        evidence["checks"]["text_stream"] = {
            "timestamp": now(),
            "result": "pass",
            "prompt_http_status": prompt_status,
            **growth,
        }
        evidence["checks"]["idle"] = {"result": "pass", **idle}

        previous_events = stream.snapshot()
        final_lengths = [
            len(assistant_text(event.get("message", {})))
            for _, event in previous_events
            if event.get("type") == "upsert" and event.get("session") == real_ref and assistant_text(event.get("message", {}))
        ]
        final_length = max(final_lengths)
        before_tree, before_workers = process_evidence(server.pid)
        stream.close()

        reconnect = SseReader()
        reconnect.start()
        streams.append(reconnect)

        def repainted(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events:
                if event.get("type") != "snapshot" or event.get("session") != real_ref:
                    continue
                lengths = [len(assistant_text(message)) for message in event.get("messages", []) if assistant_text(message)]
                if lengths and max(lengths) >= final_length:
                    return {"snapshot_at": stamp, "message_count": len(event.get("messages", [])), "assistant_text_length": max(lengths)}
            return None

        repaint = reconnect.wait_for(repainted, 20, "reconnect snapshot repaint")
        after_tree, after_workers = process_evidence(server.pid)
        launched_workers.update(row["pid"] for row in after_workers)
        before_pids = sorted(row["pid"] for row in before_workers)
        after_pids = sorted(row["pid"] for row in after_workers)
        if before_pids != after_pids or len(after_pids) != 1:
            raise RuntimeError(f"Codex worker changed across reconnect: before={before_pids}, after={after_pids}")
        evidence["checks"]["reconnect"] = {
            "result": "pass",
            **repaint,
            "codex_worker_pids_before": before_pids,
            "codex_worker_pids_after": after_pids,
            "process_tree_before": before_tree,
            "process_tree_after": after_tree,
        }

        abort_start = len(reconnect.snapshot())
        long_status, long_body = json_request(
            "POST",
            ref_path(real_ref, "/prompt"),
            {"text": "Do not use tools. Write the integers from 1 through 10000, one per line, and continue until every integer is written."},
        )
        if long_status != 202:
            raise RuntimeError(f"long prompt failed: HTTP {long_status} {long_body}")

        def active(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[abort_start:]:
                if streaming_value(event, real_ref) is True:
                    return stamp
            return None

        active_at = reconnect.wait_for(active, 60, "long turn streaming=true")
        time.sleep(0.35)

        # Everything the abort is judged on has to arrive after this point.
        # Scanning from the prompt instead lets a turn that ended on its own --
        # or an idle event left over from the reconnect -- stand in for the
        # abort, and that is a pass the check cannot tell from a real one. So:
        # pin the cut, require the turn to be streaming right up to it, and
        # accept only an idle that arrives past it.
        #
        # The cut is taken immediately before the request, not after it, so a
        # turn that ends of its own accord during the abort's round trip still
        # satisfies this. That hole is narrow rather than closed; closing it
        # needs a causal signal from the backend, which the SSE stream does not
        # carry.
        pre_abort = reconnect.snapshot()
        abort_index = len(pre_abort)
        pre_abort_streaming = last_streaming(pre_abort, real_ref)
        if pre_abort_streaming is not True:
            raise RuntimeError(
                "long turn was not streaming when the abort was issued "
                f"(last reported state: {pre_abort_streaming})"
            )
        length_at_abort = max_assistant_length(pre_abort, real_ref)

        abort_requested_at = now()
        abort_status, abort_body = json_request("POST", ref_path(real_ref, "/abort"))
        if abort_status != 204:
            raise RuntimeError(f"abort failed: HTTP {abort_status} {abort_body}")

        def aborted_idle(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[abort_index:]:
                if streaming_value(event, real_ref) is False:
                    return {"timestamp": stamp, "event_type": event.get("type")}
            return None

        aborted_idle_event = reconnect.wait_for(aborted_idle, 60, "aborted turn streaming=false")

        # Idle is a claim about the turn; the transcript is what proves it. A
        # turn that keeps emitting text after reporting idle was not aborted.
        settled_length = max_assistant_length(reconnect.snapshot(), real_ref)
        time.sleep(1.5)
        after_length = max_assistant_length(reconnect.snapshot(), real_ref)
        if after_length != settled_length:
            raise RuntimeError(
                f"transcript kept growing after the abort reported idle: {settled_length} -> {after_length}"
            )
        evidence["checks"]["abort"] = {
            "result": "pass",
            "prompt_http_status": long_status,
            "streaming_at": active_at,
            "streaming_at_abort": pre_abort_streaming,
            "events_before_abort": abort_index,
            "abort_requested_at": abort_requested_at,
            "abort_http_status": abort_status,
            "idle_at": aborted_idle_event["timestamp"],
            "idle_event_type": aborted_idle_event["event_type"],
            "assistant_length_at_abort": length_at_abort,
            "assistant_length_when_idle": settled_length,
            "assistant_length_after_settling": after_length,
        }

        evidence["shutdown_requested_at"] = now()
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=30)
        evidence["server_exit"] = {"timestamp": now(), "returncode": server.returncode}
        deadline = time.monotonic() + 10
        remaining = sorted(pid for pid in launched_workers if Path(f"/proc/{pid}").exists())
        while remaining and time.monotonic() < deadline:
            time.sleep(0.1)
            remaining = sorted(pid for pid in launched_workers if Path(f"/proc/{pid}").exists())
        evidence["checks"]["shutdown"] = {
            "result": "pass" if not remaining else "fail",
            "launched_codex_worker_pids": sorted(launched_workers),
            "remaining_worker_pids": remaining,
        }
        if remaining:
            raise RuntimeError(f"run-scoped Codex workers remained after shutdown: {remaining}")

        evidence["finished_at"] = now()
        evidence["result"] = "pass"
        exit_code = 0
    except Exception as error:
        evidence["finished_at"] = now()
        evidence["result"] = "fail"
        evidence["error"] = f"{type(error).__name__}: {error}"
        if server_log.exists():
            evidence["server_log_tail"] = server_log.read_text(errors="replace")[-4000:]
        exit_code = 1
    finally:
        for stream in streams:
            stream.close()

        # Enumerate before signalling anything. `launched_workers` is only
        # appended to at the create and reconnect checkpoints, so a run that
        # fails before them -- or between them -- has an empty set, and cleanup
        # would report a clean bill of health for a worker it never looked at.
        # Once the server is dead its children are reparented and this tree is
        # gone, so this is the last moment the set can be completed.
        if server is not None:
            try:
                launched_workers.update(row["pid"] for row in codex_workers(descendants(server.pid)))
            except OSError:
                pass

        if server is not None and server.poll() is None:
            server.send_signal(signal.SIGTERM)
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)

        # Cleanup is a criterion, not a courtesy. `ignore_errors` and
        # `missing_ok` make removal silent whether or not it worked, and a run
        # that leaves a live sandboxed agent or a copy of the credentials
        # behind has not passed no matter what its checks said. This runs on
        # the failure path too: that is where leaks actually happen.
        orphaned = reap(launched_workers, 10)
        shutil.rmtree(state_home, ignore_errors=True)
        server_log.unlink(missing_ok=True)
        cleanup: dict[str, Any] = {
            "orphaned_worker_pids": orphaned,
            "codex_home_removed": not state_home.exists(),
            "server_log_removed": not server_log.exists(),
        }
        cleanup["result"] = (
            "pass"
            if not orphaned and cleanup["codex_home_removed"] and cleanup["server_log_removed"]
            else "fail"
        )
        evidence["cleanup"] = cleanup
        if cleanup["result"] == "fail" and evidence.get("result") == "pass":
            evidence["result"] = "fail"
            evidence["error"] = f"checks passed but cleanup did not: {cleanup}"
            exit_code = 1

    print(json.dumps(evidence, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
