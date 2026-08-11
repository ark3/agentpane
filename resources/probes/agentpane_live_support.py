#!/usr/bin/env python3
"""Shared machinery for the live backend smoke checks.

`agentpane_codex_smoke.py` and `agentpane_pi_smoke.py` differ only in which
backend they drive and what they assert about it. Everything else -- launching
the production server, reading its SSE stream, walking the process tree it
owns, and proving the run cleaned up after itself -- is the same problem twice,
and was the same code twice until this module.

Two guarantees this module is responsible for, because both harnesses claim
them:

* **Credentials are copied by name and never printed.** Callers pass the file
  names their backend needs; nothing here reads their contents.
* **Process inspection is scoped to the launched server's tree.** Finding
  descendants costs one parent link per process, which is the only way Linux
  answers the question. Command lines are read only for pids already
  established as descendants, so nothing outside the tree is ever opened.
"""

from __future__ import annotations

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


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="milliseconds")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Http:
    """A host/port-bound client. Bound rather than global so two harnesses can
    exist in one process without one silently retargeting the other."""

    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=60)
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

    def json(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
        status, raw = self.request(method, path, body)
        return status, json.loads(raw) if raw else None


def ref_path(ref: dict[str, str], suffix: str = "") -> str:
    from urllib.parse import quote

    return f"/api/sessions/{ref['backend']}/{quote(ref['id'], safe='')}{suffix}"


# ---------------------------------------------------------------------------
# process tree
# ---------------------------------------------------------------------------


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
    """Live descendants of `root`, with command lines read for those alone."""
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


def compact_tree(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tree rows without full command lines, which is what belongs in evidence."""
    return [
        {"pid": row["pid"], "ppid": row["ppid"], "comm": row["comm"], "argv0": row["cmd"].split(" ", 1)[0]}
        for row in rows
    ]


def reap(pids: set[int], grace: float) -> list[int]:
    """Wait out this run's own agent workers, then kill whatever is left.

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


# ---------------------------------------------------------------------------
# SSE
# ---------------------------------------------------------------------------


class SseReader:
    def __init__(self, host: str, port: int) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self._host = host
        self._port = port
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
            self._conn = http.client.HTTPConnection(self._host, self._port, timeout=120)
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


# ---------------------------------------------------------------------------
# reading the transcript off the wire
# ---------------------------------------------------------------------------


def assistant_text(message: dict[str, Any]) -> str:
    if message.get("role") != "assistant":
        return ""
    return "".join(
        block.get("text", "")
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


def message_block_types(message: dict[str, Any]) -> list[str]:
    return [
        block.get("type", "")
        for block in message.get("content", [])
        if isinstance(block, dict)
    ]


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


def growing_assistant_text(
    events: list[tuple[str, dict[str, Any]]], ref: dict[str, str], start: int
) -> Any:
    """Evidence that a transcript arrived incrementally rather than in one lump.

    Returns as soon as growth is established, so `last` is a length mid-stream,
    not the completed message.
    """
    lengths_by_index: dict[int, list[int]] = {}
    for _, event in events[start:]:
        if event.get("type") != "upsert" or event.get("session") != ref:
            continue
        text = assistant_text(event.get("message", {}))
        if text:
            lengths_by_index.setdefault(event.get("index", -1), []).append(len(text))
    for index, lengths in lengths_by_index.items():
        distinct = sorted(set(lengths))
        if len(distinct) >= 2 and distinct[-1] > distinct[0]:
            return {
                "index": index,
                "updates": len(lengths),
                "distinct_lengths": len(distinct),
                "first": distinct[0],
                "last": distinct[-1],
            }
    return None


# ---------------------------------------------------------------------------
# running the production server
# ---------------------------------------------------------------------------


def make_state_home(real_dir: Path, names: tuple[str, ...], prefix: str) -> tuple[Path, list[str]]:
    """A throwaway backend state dir with real credentials copied in by name.

    Both agents need a writable state directory and both have one that is
    read-only when this repo's own session is sandboxed; an inner sbox cannot
    re-mount read-write what the outer namespace mounted read-only. Copying the
    credentials into a temporary home under /var/tmp is the workaround, and it
    also keeps a live run from writing into the developer's real store.

    Contents are never read here, only copied, and the names copied are
    returned so a run can record what it used without naming what was in it.
    """
    home = Path(tempfile.mkdtemp(prefix=prefix, dir="/var/tmp"))
    copied: list[str] = []
    for name in names:
        source = real_dir / name
        if source.exists():
            shutil.copy2(source, home / name)
            copied.append(name)
    return home, copied


def build_client(repo: Path) -> dict[str, Any]:
    built = subprocess.run(
        ["bun", "run", "build"], cwd=repo, capture_output=True, text=True, timeout=180
    )
    if built.returncode != 0:
        raise RuntimeError(f"client build failed: {(built.stdout + built.stderr)[-2000:]}")
    return {"returncode": built.returncode}


def start_server(repo: Path, env: dict[str, str], log: Path) -> subprocess.Popen[bytes]:
    handle = log.open("wb")
    try:
        return subprocess.Popen(
            ["bun", "run", "start"],
            cwd=repo,
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    finally:
        handle.close()


def wait_for_built_client(
    http: Http, server: subprocess.Popen[bytes], timeout: float
) -> tuple[int, bytes]:
    """Block until the production server serves the built client, or give up.

    `Accept: text/html` matters: `createStaticHandler` limits the SPA fallback
    to navigation requests, so a probe without it gets a 404 that looks like a
    broken build.
    """
    deadline = time.monotonic() + timeout
    status, body = 0, b""
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"server exited during startup with {server.returncode}")
        try:
            status, body = http.request("GET", "/", headers={"accept": "text/html"})
            if status == 200:
                return status, body
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("built client was not reachable")


def finalize(
    evidence: dict[str, Any],
    exit_code: int,
    *,
    server: subprocess.Popen[bytes] | None,
    streams: list[SseReader],
    state_home: Path,
    server_log: Path,
    launched_workers: set[int],
    worker_filter: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
) -> int:
    """Tear the run down, and treat having done so as a criterion.

    `ignore_errors` and `missing_ok` make removal silent whether or not it
    worked, and a run that leaves a live sandboxed agent or a copy of the
    credentials behind has not passed no matter what its checks said. This runs
    on the failure path too: that is where leaks actually happen.
    """
    for stream in streams:
        stream.close()

    # Enumerate before signalling anything. A run's worker set is only appended
    # to at its checkpoints, so a run that failed elsewhere has an incomplete
    # one -- and once the server is dead its children are reparented and the
    # tree is gone. This is the last moment the set can be completed.
    if server is not None:
        try:
            launched_workers.update(row["pid"] for row in worker_filter(descendants(server.pid)))
        except OSError:
            pass

    if server is not None and server.poll() is None:
        server.send_signal(signal.SIGTERM)
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)

    orphaned = reap(launched_workers, 10)
    shutil.rmtree(state_home, ignore_errors=True)
    server_log.unlink(missing_ok=True)
    cleanup: dict[str, Any] = {
        "orphaned_worker_pids": orphaned,
        "state_home_removed": not state_home.exists(),
        "server_log_removed": not server_log.exists(),
    }
    cleanup["result"] = (
        "pass"
        if not orphaned and cleanup["state_home_removed"] and cleanup["server_log_removed"]
        else "fail"
    )
    evidence["cleanup"] = cleanup
    if cleanup["result"] == "fail" and evidence.get("result") == "pass":
        evidence["result"] = "fail"
        evidence["error"] = f"checks passed but cleanup did not: {cleanup}"
        return 1
    return exit_code
