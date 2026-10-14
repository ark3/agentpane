#!/usr/bin/env python3
"""What Pi and agentpane make of a prompt in a run's starting window, and of
one an extension handles (OW-kokotu).

Two questions, both opened by Pi's changelog rather than by anything run:

* `pi 1.2.0` counts a session busy from the moment a run starts, before
  `agent_start`. `PiAdapter.submit` in `src/server/adapters/pi/process.ts`
  adds `streamingBehavior: "steer"` only once the reducer has seen
  `agent_start`, so a second prompt in that window goes out bare.
* `pi 0.99.0` answers a successful `prompt` with `data.disposition`, and
  `"handled"` means no run started, so no `agent_settled` follows. The adapter
  ignores the response body.

## Part `rpc`: Pi alone

Spawns `pi --mode rpc --no-session --model <pinned>` directly, without
agentpane, and reads its stdout raw, stamping each `read()` chunk on arrival
so that "did `agent_start` arrive in the same chunk as the `prompt`
response" is answerable. Cells:

* `timing`: `TIMING_RUNS` single prompts, each awaited to `agent_settled`,
  timing write -> response -> `agent_start` on the probe's clock.
* `pipelined_bare`: two bare prompts in one `write()`, the second sent before
  the first's response.
* `pipelined_steer`: as `pipelined_bare`, the second carrying
  `streamingBehavior: "steer"`, which is what an adapter that always set it
  would send.
* `idle_steer`: one prompt carrying `streamingBehavior: "steer"` while Pi is
  idle, the other half of what such an adapter would send.
* `after_response_bare`: the second bare prompt written by the reader thread
  the instant it parses the first's response line, before it parses anything
  after it. `agent_start` in the same chunk would mean Pi had written it by
  then; in a later chunk is not proof it had not, since it may already have
  been in the pipe.
* `handled`: every `get_commands` entry whose source is `extension`, sent as a
  prompt with nothing after the name.

## Part `agentpane`: through the built server

Drives the real chain -- `direnv exec <workspace> sbox -- pi --mode rpc
--model <pinned>`, spawned by agentpane's built server, through the REST
prompt route -- with a `pi` shim first on the server's PATH that copies Pi's
stdin and stdout to two tap files, as `agentpane_pi_steer_probe.py` copies its
stdout. The stdin tap is what shows whether a prompt carried
`streamingBehavior`. Cells:

* `concurrent_posts`: two POSTs released together from two threads.
* `post_after_202`: the second POST sent the moment the first's 202 returns.
* `handled_<name>`: each extension command as a POST, then `HANDLED_WAIT`
  seconds of the SSE wire, then an ordinary prompt to show what follows.

## The configuration

"Stock" is this machine's: `PI_CODING_AGENT_DIR` points at a temporary copy
of `~/.pi/agent` holding the credential and settings files by name and the
`extensions/` directory dereferenced, so the user extensions installed there
load as they would for agentpane, and Pi's built-in extensions load as they
do by default. The copy keeps the runs out of the real session store. The
workspace is a fresh directory under `/var/tmp` carrying only the
`.sandbox-workspace` marker sbox needs, so no project `AGENTS.md`, `.pi/` or
prompt template is in play.

Every model call is pinned by `--model` (AGENTS.md) and each prompt asks for
one word. This makes real model calls, never invokes Codex or Claude, copies
Pi credentials by name without reading them, and signals only pids it
recorded as its own.
"""

from __future__ import annotations

import argparse
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

from agentpane_live_support import (
    Http,
    SseReader,
    build_client,
    compact_tree,
    descendants,
    finalize,
    last_streaming,
    make_state_home,
    now,
    ref_path,
    start_server,
    transcript,
    wait_for_built_client,
)

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 44177
PI_STATE_FILES = ("auth.json", "models.json", "models-store.json", "settings.json", "trust.json")
PINNED_MODEL = "openrouter/deepseek/deepseek-v4.1-flash:high"
TIMING_RUNS = 5
HANDLED_WAIT = 5.0
QUIET = 2.0
LIFECYCLE = ("agent_start", "agent_end", "agent_settled")


def word(w: str) -> str:
    return f"Reply with exactly the single word {w} and nothing else. Do not use tools."


def make_pi_home(source: Path) -> tuple[Path, list[str], list[str]]:
    home, copied = make_state_home(source, PI_STATE_FILES, "agentpane-window-pihome-")
    extensions: list[str] = []
    if (source / "extensions").is_dir():
        shutil.copytree(source / "extensions", home / "extensions", symlinks=False)
        extensions = sorted(p.name for p in (home / "extensions").iterdir())
    return home, copied, extensions


def make_workspace() -> Path:
    workspace = Path(tempfile.mkdtemp(prefix="agentpane-window-ws-", dir="/var/tmp"))
    (workspace / ".sandbox-workspace").touch()
    return workspace


def lifecycle_of(event: dict[str, Any]) -> str | None:
    kind = event.get("type")
    return kind if kind in LIFECYCLE else None


def summarise(event: dict[str, Any]) -> dict[str, Any]:
    """An event with the deltas and payloads cut down to what this probe reads."""
    kind = event.get("type")
    row: dict[str, Any] = {"type": kind}
    if kind == "response":
        row.update({k: event.get(k) for k in ("id", "command", "success")})
        if event.get("success"):
            data = event.get("data")
            if event.get("command") in ("prompt", "steer", "follow_up"):
                row["data"] = data
        else:
            row["error"] = event.get("error")
    elif kind in ("message_start", "message_end"):
        message = event.get("message") or {}
        row["role"] = message.get("role")
        content = message.get("content")
        if message.get("role") == "user":
            row["text"] = content if isinstance(content, str) else "".join(
                b.get("text", "") for b in content or [] if isinstance(b, dict)
            )
        if message.get("role") == "assistant":
            row["stopReason"] = message.get("stopReason")
    elif kind == "extension_ui_request":
        row.update({k: event.get(k) for k in ("method", "message", "notifyType", "statusKey", "title")})
    elif kind == "queue_update":
        row.update({k: event.get(k) for k in ("steering", "followUp")})
    elif kind in ("extension_error",):
        row.update({k: event.get(k) for k in ("extensionPath", "event", "error")})
    return row


# ---------------------------------------------------------------------------
# part rpc
# ---------------------------------------------------------------------------


class PiRpc:
    """Pi on raw pipes, every stdout chunk stamped on the probe's clock."""

    def __init__(self, pi: str, model: str, home: Path, workspace: Path) -> None:
        self.t0 = time.monotonic()
        self.proc = subprocess.Popen(
            [pi, "--mode", "rpc", "--no-session", "--model", model],
            cwd=workspace,
            env=dict(os.environ, PI_CODING_AGENT_DIR=str(home)),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            start_new_session=True,
        )
        self.lines: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.on_line: Callable[[dict[str, Any]], None] | None = None
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def clock(self) -> float:
        return round(time.monotonic() - self.t0, 4)

    def _read(self) -> None:
        assert self.proc.stdout is not None
        fd = self.proc.stdout.fileno()
        buffer = b""
        chunk_no = 0
        while True:
            data = os.read(fd, 65536)
            if not data:
                return
            stamp = self.clock()
            chunk_no += 1
            buffer += data
            *complete, buffer = buffer.split(b"\n")
            for raw in complete:
                if not raw.strip():
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    event = {"type": "<unparsed>", "raw": raw[:200].decode(errors="replace")}
                row = {"t": stamp, "chunk": chunk_no, "event": event}
                with self.lock:
                    self.lines.append(row)
                hook = self.on_line
                if hook is not None:
                    hook(row)

    def write(self, *commands: dict[str, Any]) -> float:
        payload = b"".join(json.dumps(c).encode() + b"\n" for c in commands)
        assert self.proc.stdin is not None
        with self.write_lock:
            stamp = self.clock()
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()
        return stamp

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.lines)

    def wait(self, predicate: Callable[[list[dict[str, Any]]], Any], timeout: float, label: str) -> Any:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate(self.snapshot())
            if value:
                return value
            time.sleep(0.02)
        raise TimeoutError(f"timed out waiting for {label}")

    def response(self, start: int, command_id: str) -> Callable[[list[dict[str, Any]]], Any]:
        def found(rows: list[dict[str, Any]]) -> Any:
            for row in rows[start:]:
                event = row["event"]
                if event.get("type") == "response" and event.get("id") == command_id:
                    return row
            return None

        return found

    def settle(self, start: int, timeout: float = 120) -> dict[str, Any]:
        """Wait until Pi is idle: quiet for `QUIET` seconds with no run open.

        A run is open from an `agent_start` until the next `agent_settled`;
        a continuation may emit `agent_start` again inside one run, so the
        count is of starts with no settle after them, not a balance. Confirmed
        by `get_state`'s `isStreaming`.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            rows = self.snapshot()
            last = None
            for row in rows[start:]:
                kind = lifecycle_of(row["event"])
                if kind is not None:
                    last = kind
            quiet = not rows or self.clock() - rows[-1]["t"] >= QUIET
            if quiet and last in (None, "agent_settled"):
                mark = len(self.snapshot())
                command_id = f"state-{mark}"
                self.write({"id": command_id, "type": "get_state"})
                reply = self.wait(self.response(mark, command_id), 10, "get_state")
                if reply["event"]["data"]["isStreaming"] is False:
                    return {"idle_at": self.clock(), "isStreaming": False}
            time.sleep(0.1)
        raise TimeoutError("Pi did not settle")

    def close(self) -> None:
        if self.proc.stdin is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.kill(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=5)
        self.thread.join(timeout=2)


def cell_rows(rows: list[dict[str, Any]], start: int) -> list[dict[str, Any]]:
    return [{"t": r["t"], "chunk": r["chunk"], **summarise(r["event"])} for r in rows[start:]
            if r["event"].get("type") not in ("message_update",)]


def first_of(rows: list[dict[str, Any]], start: int, kind: str) -> dict[str, Any] | None:
    for row in rows[start:]:
        if row["event"].get("type") == kind:
            return row
    return None


def run_rpc(args: argparse.Namespace, pi: str, home: Path, workspace: Path) -> dict[str, Any]:
    rpc = PiRpc(pi, args.model, home, workspace)
    out: dict[str, Any] = {"command": [pi, "--mode", "rpc", "--no-session", "--model", args.model]}
    try:
        mark = len(rpc.snapshot())
        rpc.write({"id": "state0", "type": "get_state"}, {"id": "cmds", "type": "get_commands"})
        state = rpc.wait(rpc.response(mark, "state0"), 30, "get_state")["event"]["data"]
        commands = rpc.wait(rpc.response(mark, "cmds"), 30, "get_commands")["event"]["data"]["commands"]
        out["get_state"] = {
            "model": f"{state['model']['provider']}/{state['model']['id']}",
            "thinkingLevel": state.get("thinkingLevel"),
        }
        out["get_commands"] = [
            {"name": c["name"], "source": c["source"], "path": (c.get("sourceInfo") or {}).get("path")}
            for c in commands
        ]
        rpc.settle(0)

        # -- timing -----------------------------------------------------------
        timing = []
        for n in range(TIMING_RUNS):
            start = len(rpc.snapshot())
            sent = rpc.write({"id": f"t{n}", "type": "prompt", "message": word("OK")})
            resp = rpc.wait(rpc.response(start, f"t{n}"), 60, "timing response")
            began = rpc.wait(lambda rows, s=start: first_of(rows, s, "agent_start"), 60, "agent_start")
            rpc.settle(start)
            timing.append({
                "disposition": (resp["event"].get("data") or {}).get("disposition"),
                "write_to_response_s": round(resp["t"] - sent, 4),
                "response_to_agent_start_s": round(began["t"] - resp["t"], 4),
                "response_chunk": resp["chunk"],
                "agent_start_chunk": began["chunk"],
                "same_chunk": resp["chunk"] == began["chunk"],
                "response_before_agent_start": rpc.snapshot().index(resp) < rpc.snapshot().index(began),
            })
        out["timing"] = timing

        # -- pipelined, bare and steer ------------------------------------------
        for name, extra in (("pipelined_bare", {}), ("pipelined_steer", {"streamingBehavior": "steer"})):
            start = len(rpc.snapshot())
            sent = rpc.write(
                {"id": f"{name}-a", "type": "prompt", "message": word("ALPHA")},
                {"id": f"{name}-b", "type": "prompt", "message": word("BRAVO"), **extra},
            )
            a = rpc.wait(rpc.response(start, f"{name}-a"), 60, f"{name} A")
            b = rpc.wait(rpc.response(start, f"{name}-b"), 60, f"{name} B")
            rpc.settle(start)
            rows = rpc.snapshot()
            out[name] = {
                "written_at": sent,
                "a_response": summarise(a["event"]),
                "b_response": summarise(b["event"]),
                "rows": cell_rows(rows, start),
            }

        # -- steer on an idle session ---------------------------------------------
        start = len(rpc.snapshot())
        rpc.write({"id": "idle-steer", "type": "prompt", "message": word("FOXTROT"), "streamingBehavior": "steer"})
        resp = rpc.wait(rpc.response(start, "idle-steer"), 60, "idle steer")
        rpc.settle(start)
        out["idle_steer"] = {"response": summarise(resp["event"]), "rows": cell_rows(rpc.snapshot(), start)}

        # -- after the response, before agent_start ------------------------------
        start = len(rpc.snapshot())
        record: dict[str, Any] = {}

        def fire(row: dict[str, Any]) -> None:
            event = row["event"]
            if event.get("type") == "response" and event.get("id") == "after-a" and "b_written_at" not in record:
                record["b_written_at"] = rpc.write({"id": "after-b", "type": "prompt", "message": word("BRAVO")})
                record["a_response_chunk"] = row["chunk"]
                record["agent_start_already_parsed"] = first_of(rpc.snapshot(), start, "agent_start") is not None

        rpc.on_line = fire
        rpc.write({"id": "after-a", "type": "prompt", "message": word("ALPHA")})
        a = rpc.wait(rpc.response(start, "after-a"), 60, "after A")
        b = rpc.wait(rpc.response(start, "after-b"), 60, "after B")
        rpc.on_line = None
        rpc.settle(start)
        rows = rpc.snapshot()
        began = first_of(rows, start, "agent_start")
        record.update({
            "a_response": summarise(a["event"]),
            "b_response": summarise(b["event"]),
            "agent_start_chunk": began["chunk"] if began else None,
            "agent_start_in_a_response_chunk": bool(began and began["chunk"] == record.get("a_response_chunk")),
            "rows": cell_rows(rows, start),
        })
        out["after_response_bare"] = record

        # -- handled -------------------------------------------------------------
        handled = {}
        for command in (c for c in commands if c["source"] == "extension"):
            start = len(rpc.snapshot())
            command_id = f"handled-{command['name']}"
            rpc.write({"id": command_id, "type": "prompt", "message": f"/{command['name']}"})
            resp = rpc.wait(rpc.response(start, command_id), 30, command_id)
            time.sleep(HANDLED_WAIT)
            rows = rpc.snapshot()
            handled[command["name"]] = {
                "response": summarise(resp["event"]),
                "rows": cell_rows(rows, start),
                "agent_start_seen": first_of(rows, start, "agent_start") is not None,
            }
            rpc.settle(start)
        out["handled"] = handled
    finally:
        rpc.close()
    return out


# ---------------------------------------------------------------------------
# part agentpane
# ---------------------------------------------------------------------------


def make_shim(real_pi: Path, tap_in: Path, tap_out: Path) -> Path:
    """A `pi` that is the real `pi` with its stdin and stdout copied to taps.

    As `agentpane_pi_steer_probe.py`'s shim, plus a `tee` on stdin; Pi's exit
    status does not pass through, which this probe never reads.
    """
    shim_dir = Path(tempfile.mkdtemp(prefix="agentpane-window-shim-", dir="/tmp"))
    script = shim_dir / "pi"
    script.write_text(f'#!/bin/sh\ntee -a "{tap_in}" | "{real_pi}" "$@" | tee -a "{tap_out}"\n')
    script.chmod(0o755)
    return shim_dir


def pi_workers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """This run's agent-side processes: Pi, the two `tee`s, and the wrappers."""
    return [
        row
        for row in rows
        if row["comm"] in ("pi", "tee")
        or (row["comm"] in ("node", "sh") and "--mode rpc" in row["cmd"])
    ]


def read_tap(tap: Path) -> list[dict[str, Any]]:
    if not tap.exists():
        return []
    rows = []
    for line in tap.read_text(errors="replace").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                rows.append({"type": "<unparsed>", "raw": line[:200]})
    return rows


def sse_rows(events: list[tuple[str, dict[str, Any]]], start: int, handle: str) -> list[dict[str, Any]]:
    rows = []
    for stamp, event in events[start:]:
        if event.get("handle") != handle:
            continue
        kind = event.get("type")
        row: dict[str, Any] = {"at": stamp, "type": kind}
        if kind in ("snapshot", "status"):
            row["isStreaming"] = event.get("isStreaming")
        elif kind == "upsert":
            message = event.get("message") or {}
            row["index"] = event.get("index")
            row["role"] = message.get("role")
            if message.get("role") == "user":
                content = message.get("content")
                row["text"] = content if isinstance(content, str) else "".join(
                    b.get("text", "") for b in content or [] if isinstance(b, dict)
                )
            if rows and rows[-1].get("type") == "upsert" and rows[-1].get("index") == row["index"]:
                rows[-1]["count"] = rows[-1].get("count", 1) + 1
                continue
        elif kind in ("error", "notice"):
            row["message"] = event.get("message")
        rows.append(row)
    return rows


def run_agentpane(
    args: argparse.Namespace, pi: str, home: Path, workspace: Path, repo: Path, commands: list[str]
) -> dict[str, Any]:
    http = Http(HOST, args.port)
    tap_in = Path(tempfile.mkstemp(prefix="agentpane-window-in-", suffix=".jsonl", dir="/tmp")[1])
    tap_out = Path(tempfile.mkstemp(prefix="agentpane-window-out-", suffix=".jsonl", dir="/tmp")[1])
    shim_dir = make_shim(Path(pi).resolve(), tap_in, tap_out)
    server_log = Path(tempfile.mkstemp(prefix="agentpane-window-server-", suffix=".log")[1])
    server = None
    streams: list[SseReader] = []
    launched: set[int] = set()
    out: dict[str, Any] = {}
    # `finalize` removes the state home it is given; the rpc part shares it,
    # so it gets a scratch directory of its own to remove.
    scratch = Path(tempfile.mkdtemp(prefix="agentpane-window-scratch-", dir="/var/tmp"))
    exit_code = 1
    try:
        if not args.skip_build:
            out["build"] = build_client(repo)
        server = start_server(
            repo,
            dict(
                os.environ,
                PATH=f"{shim_dir}{os.pathsep}{os.environ['PATH']}",
                PI_CODING_AGENT_DIR=str(home),
                PORT=str(args.port),
            ),
            server_log,
        )
        out["server_pid"] = server.pid
        wait_for_built_client(http, server, 30)
        stream = SseReader(HOST, args.port)
        stream.start()
        streams.append(stream)

        status, created = http.json("POST", "/api/sessions", {"cwd": str(workspace), "backend": "pi", "model": args.model})
        if status != 201:
            raise RuntimeError(f"create failed: HTTP {status} {created}")
        status, attached = http.json("GET", ref_path(created["ref"]))
        if status != 200:
            raise RuntimeError(f"attach failed: HTTP {status} {attached}")
        ref = attached["session"]["ref"]
        handle = attached["session"]["handle"]
        tree = descendants(server.pid)
        launched.update(row["pid"] for row in pi_workers(tree))
        out["process_chain"] = [row["comm"] for row in compact_tree(tree)]
        # The model the session reports on the wire, which is what `--model`
        # put in force; the flag itself rides the create route's `model`.
        out["model_on_wire"] = next(
            (
                e.get("model")
                for _, e in reversed(stream.snapshot())
                if e.get("handle") == handle and e.get("type") in ("snapshot", "status") and e.get("model")
            ),
            None,
        )

        def idle_after(start: int, timeout: float = 120) -> None:
            def seen(events: list[tuple[str, dict[str, Any]]]) -> Any:
                saw_true = False
                for _, event in events[start:]:
                    if event.get("handle") == handle and event.get("type") in ("snapshot", "status"):
                        if event.get("isStreaming"):
                            saw_true = True
                        elif saw_true:
                            return True
                return None

            stream.wait_for(seen, timeout, "the session to stream and go idle")
            time.sleep(QUIET)

        def post(text: str) -> dict[str, Any]:
            sent = time.monotonic()
            status, body = http.json("POST", ref_path(ref, "/prompt"), {"text": text})
            return {"status": status, "body": body, "sent": sent, "replied": time.monotonic()}

        def cell(name: str, fire: Callable[[], list[dict[str, Any]]], wait: Callable[[int], None]) -> None:
            sse_start = len(stream.snapshot())
            in_start = len(read_tap(tap_in))
            out_start = len(read_tap(tap_out))
            t0 = time.monotonic()
            replies = fire()
            wait(sse_start)
            sent_in = read_tap(tap_in)[in_start:]
            sent_out = read_tap(tap_out)[out_start:]
            out[name] = {
                "posts": [
                    {
                        "status": r["status"],
                        "body": r["body"],
                        "sent_s": round(r["sent"] - t0, 4),
                        "replied_s": round(r["replied"] - t0, 4),
                    }
                    for r in replies
                ],
                "pi_stdin_prompts": [
                    {k: c.get(k) for k in ("id", "type", "message", "streamingBehavior")}
                    for c in sent_in
                    if c.get("type") == "prompt"
                ],
                "pi_stdout": [summarise(e) for e in sent_out if e.get("type") != "message_update"],
                "sse": sse_rows(stream.snapshot(), sse_start, handle),
                "last_streaming": last_streaming(stream.snapshot(), handle),
                "user_messages_in_transcript": [
                    m.get("content") if isinstance(m.get("content"), str) else "".join(
                        b.get("text", "") for b in m.get("content") or [] if isinstance(b, dict)
                    )
                    for m in transcript(stream.snapshot(), handle)
                    if m.get("role") == "user"
                ],
            }

        # Settle the attach's own events first.
        time.sleep(QUIET)

        def concurrent() -> list[dict[str, Any]]:
            barrier = threading.Barrier(2)
            results: list[dict[str, Any] | None] = [None, None]

            def go(i: int, text: str) -> None:
                barrier.wait()
                results[i] = post(text)

            threads = [threading.Thread(target=go, args=(0, word("ALPHA"))),
                       threading.Thread(target=go, args=(1, word("BRAVO")))]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=120)
            return [r for r in results if r is not None]

        cell("concurrent_posts", concurrent, idle_after)

        def back_to_back() -> list[dict[str, Any]]:
            first = post(word("CHARLIE"))
            return [first, post(word("DELTA"))]

        cell("post_after_202", back_to_back, idle_after)

        for name in commands:
            cell(
                f"handled_{name}",
                lambda n=name: [post(f"/{n}")],
                lambda _start: time.sleep(HANDLED_WAIT),
            )
            cell(f"after_handled_{name}", lambda: [post(word("ECHO"))], idle_after)

        exit_code = 0
    except Exception as error:
        out["error"] = f"{type(error).__name__}: {error}"
        if server_log.exists():
            out["server_log_tail"] = server_log.read_text(errors="replace")[-4000:]
    finally:
        cleanup: dict[str, Any] = {}
        finalize(
            cleanup,
            exit_code,
            server=server,
            streams=streams,
            state_home=scratch,
            server_log=server_log,
            launched_workers=launched,
            worker_filter=pi_workers,
        )
        out["cleanup"] = cleanup.get("cleanup")
        shutil.rmtree(shim_dir, ignore_errors=True)
        tap_in.unlink(missing_ok=True)
        tap_out.unlink(missing_ok=True)
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app-root", type=Path, default=REPO)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--model", default=PINNED_MODEL, help="model ref for Pi's --model (default: AGENTS.md's pin)")
    parser.add_argument("--credential-source", type=Path, default=Path.home() / ".pi" / "agent")
    parser.add_argument("--part", choices=("rpc", "agentpane", "both"), default="both")
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing dist/client bundle")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = args.app_root.expanduser().resolve()
    pi = shutil.which("pi")
    if pi is None:
        raise SystemExit("pi is not on PATH")
    home, copied, extensions = make_pi_home(args.credential_source.expanduser().resolve())
    workspace = make_workspace()
    evidence: dict[str, Any] = {
        "started_at": now(),
        "probe": "agentpane_pi_prompt_window_probe.py",
        "card": "OW-kokotu",
        "commit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip(),
        "pi_version": subprocess.run([pi, "--version"], capture_output=True, text=True, check=True).stdout.strip(),
        "model_flag": args.model,
        "copied_state_files": copied,
        "copied_extensions": extensions,
        "workspace": str(workspace),
    }
    code = 0
    try:
        if "auth.json" not in copied:
            raise SystemExit(f"missing Pi credentials under {args.credential_source}")
        commands: list[str] = []
        if args.part in ("rpc", "both"):
            evidence["rpc"] = run_rpc(args, pi, home, workspace)
            commands = [c["name"] for c in evidence["rpc"]["get_commands"] if c["source"] == "extension"]
        if args.part in ("agentpane", "both"):
            if not commands:
                commands = ["mcp"]
            evidence["agentpane"] = run_agentpane(args, pi, home, workspace, repo, commands)
            if "error" in evidence["agentpane"] or (evidence["agentpane"].get("cleanup") or {}).get("result") != "pass":
                code = 1
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
        code = 1
    finally:
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)
        evidence["state_home_removed"] = not home.exists()
        evidence["finished_at"] = now()
    print(json.dumps(evidence, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
