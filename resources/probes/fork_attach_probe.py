#!/usr/bin/env python3
"""Fork the most recent turn, then attach the fork, through the production server.

The client's `forkAndSubmit` is a four-request round trip -- fork points, fork,
attach, prompt -- and the three backends reach "attached to the fork" by three
different routes: Pi's fork moves the live process onto a new file, Codex
flushes the forked rollout to disk before `thread/fork` returns, and Claude
Code's fork runs nothing at all until the attach spawns it (OW-razoki,
OW-japuzo).  Nothing had ever run that sequence against a real backend through
the real HTTP surface; `fork_probe.py` drives the CLIs directly and never sees
agentpane's session manager, and the browser vehicle in `e2e/` has no server.

This probe is the missing middle.  It reports rather than asserts: a failing
attach is the measurement, not a crash, so every step records its HTTP status
and body and the run continues to the next one.

What it drives, per backend:

  1. fork at the LAST fork point -- the "edit last message" case, after two
     real turns, so "the most recent turn" is not also the first
  2. attach the fork, prompt it, and read the reply back off the wire
  3. re-attach that fork once its store file exists
  4. fork the fork at ITS most recent turn
  5. on Codex only: close one side of the fork pair and attach it again while
     the other side is still live (OW-voyezi)
  6. fork the parent a second time at the same point it was forked at

Step 5 is Codex's alone because the lock is Codex's alone.  A Codex fork shares
its parent's `codex app-server` (OW-lajehi) and a thread stays locked to the
process that opened it even after the adapter holding it is disposed, so this is
the sequence that used to answer `500 internal_error`,
`already has an active writer`.  Pi and Claude Code spawn a child per session
and have nothing to re-borrow.

Every backend runs against its REAL state directory, and this run therefore
leaves three or four small sessions in each store it touches.  That is not
laziness and it cannot be avoided by relocating the CLI: agentpane derives the
session roots from `homedir()` and reads no `CODEX_HOME`, `PI_CODING_AGENT_DIR`
or `CLAUDE_CONFIG_DIR` (`src/server/sessions/index.ts`, `claude/adapter.ts`),
so a run that moves the CLI's store moves it out from under the server's own
index -- and the attach this probe measures is exactly the request that
consults that index.  Measured on 2026-09-15: with `CODEX_HOME` relocated,
every Codex fork attach 404s on a rollout that is demonstrably on disk, and a
relocated `CLAUDE_CONFIG_DIR` yields no fork points at all.  Both are the
harness lying, not the product failing, which is the whole reason this note is
longer than the code it explains.

Each backend is pinned to its model explicitly rather than inheriting whatever
the settings file happens to say (AGENTS.md; OW-yehisa is that defect in the
two smoke harnesses).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from agentpane_live_support import (
    Http,
    SseReader,
    assistant_text,
    build_client,
    finalize,
    now,
    ref_path,
    start_server,
    streaming_value,
    wait_for_built_client,
)

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 44177

# Per backend: the store the server itself reads, the model the pin names, and
# how its worker shows up in the server's process tree.  `store_root` is used
# only to watch a fork appear on disk; nothing here ever writes to it or
# removes it.
BACKENDS: dict[str, dict[str, Any]] = {
    "pi": {
        "store_root": "~/.pi/agent/sessions",
        "model": "openrouter/deepseek/deepseek-v4.1-flash:high",
        "comms": ("pi",),
        "version": ["pi", "--version"],
    },
    "codex": {
        "store_root": "~/.codex/sessions",
        "model": "gpt-5.6-luna",
        "comms": ("codex", "codex-app-server"),
        "version": ["codex", "--version"],
    },
    "claude": {
        "store_root": "~/.claude/projects",
        "model": "haiku",
        "comms": ("claude", "node"),
        "version": ["claude", "--version"],
    },
}


def worker_filter_for(backend: str):
    comms = BACKENDS[backend]["comms"]
    return lambda rows: [row for row in rows if row["comm"] in comms]


def follow_renames(events: list[tuple[str, dict[str, Any]]], ref: dict[str, str]) -> dict[str, str]:
    """Where `ref` has moved to, if a `renamed` chain moved it.

    Every backend replaces a `virtual:` ref at attach (D9), and Pi's id is its
    JSONL path, so a probe that holds the ref it created stops matching its
    own session's events.
    """
    current = ref
    for _, event in events:
        if event.get("type") == "renamed" and event.get("from") == current:
            nxt = event.get("session")
            if isinstance(nxt, dict):
                current = nxt
    return current


def turn(
    http: Http, stream: SseReader, ref: dict[str, str], text: str, timeout: float
) -> dict[str, Any]:
    """Prompt, wait for streaming to go up and come back down, report the reply."""
    start = len(stream.snapshot())
    status, body = http.json("POST", ref_path(ref, "/prompt"), {"text": text})
    record: dict[str, Any] = {"prompt_http": status, "prompted_at": now()}
    if status != 202:
        record["prompt_body"] = body
        return record

    def settled(events: list[tuple[str, dict[str, Any]]]) -> Any:
        live = follow_renames(events, ref)
        seen_streaming = False
        for stamp, event in events[start:]:
            value = streaming_value(event, live)
            if value is True:
                seen_streaming = True
            elif value is False and seen_streaming:
                return {"idle_at": stamp, "ref": live}
        return None

    try:
        done = stream.wait_for(settled, timeout, f"the turn prompted with {text!r} to finish")
    except TimeoutError as exc:
        record["result"] = "timeout"
        record["error"] = str(exc)
        return record
    live = done["ref"]
    replies = [
        assistant_text(event.get("message", {}))
        for _, event in stream.snapshot()[start:]
        if event.get("type") == "upsert" and event.get("session") == live
    ]
    record.update(
        result="pass",
        idle_at=done["idle_at"],
        ref=live,
        reply_tail=(replies[-1][-200:] if replies else ""),
    )
    return record


def transcript_of(stream: SseReader, ref: dict[str, str]) -> dict[str, Any]:
    """The newest snapshot this session broadcast, summarised by role."""
    for _, event in reversed(stream.snapshot()):
        if event.get("type") == "snapshot" and event.get("session") == ref:
            messages = event.get("messages", [])
            return {
                "count": len(messages),
                "roles": [m.get("role") for m in messages],
                "user_texts": [
                    "".join(
                        b.get("text", "")
                        for b in m.get("content", [])
                        if isinstance(b, dict) and b.get("type") == "text"
                    )[:60]
                    for m in messages
                    if m.get("role") == "user"
                ],
            }
    return {"count": None}


def find_on_disk(store_root: Path, backend: str, fork_ref: dict[str, str], window: float) -> Any:
    """How long the fork took to show up in the backend's store, if it ever did.

    The manager resolves an attach it has no table entry for through the
    session index, which is a walk of that store (`SessionManager.#start`), so
    "on disk" and "attachable" are the same question for Codex and Pi.  Polled
    rather than sampled once: a fork written a beat after `thread/fork` returns
    and a fork never written at all fail the same attach, and only the clock
    tells them apart.
    """
    if backend == "claude":
        return None  # its store file does not exist until the first turn ends (OW-japuzo)
    target = fork_ref["id"]
    started = time.monotonic()
    deadline = started + window
    while True:
        if backend == "pi":
            found = Path(target).exists()
        else:
            found = any(target in p.name for p in store_root.rglob("*.jsonl"))
        if found:
            return round(time.monotonic() - started, 3)
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.1)


def fork_at_last_point(
    http: Http,
    stream: SseReader,
    ref: dict[str, str],
    *,
    backend: str,
    store_root: Path,
) -> dict[str, Any]:
    """Fork points, the last of them, the fork, and the attach -- in that order.

    This is `forkAndSubmit`'s sequence minus the prompt, and the attach is the
    step the whole probe exists to watch.
    """
    step: dict[str, Any] = {"at": now(), "parent": ref}
    points_status, points = http.json("GET", ref_path(ref, "/fork-points"))
    step["fork_points_http"] = points_status
    if points_status != 200 or not points.get("points"):
        step["fork_points_body"] = points
        step["result"] = "no fork points"
        return step
    listed = points["points"]
    step["fork_points"] = [
        {"index": p.get("index"), "text": (p.get("text") or "")[:60]} for p in listed
    ]
    last = listed[-1]
    step["forked_at"] = {"index": last.get("index"), "text": (last.get("text") or "")[:60]}

    fork_status, forked = http.json("POST", ref_path(ref, "/fork"), {"entryId": last["id"]})
    step["fork_http"] = fork_status
    if fork_status not in (200, 201):
        step["fork_body"] = forked
        step["result"] = "fork rejected"
        return step
    fork_ref = forked.get("ref")
    step["fork_ref"] = fork_ref

    step["on_disk_after_seconds"] = find_on_disk(store_root, backend, fork_ref, 5.0)

    attach_status, attached = http.json("GET", ref_path(fork_ref))
    step["attach_http"] = attach_status
    step["attach_body"] = attached
    if attach_status != 200:
        # Once more, well after the fork call, so "the store had not caught up"
        # and "nothing was ever written" are distinguishable in the record.
        time.sleep(5)
        step["on_disk_after_retry_seconds"] = find_on_disk(store_root, backend, fork_ref, 0.1)
        retry_status, retried = http.json("GET", ref_path(fork_ref))
        step["retry_attach_http"] = retry_status
        step["retry_attach_body"] = retried
        attach_status, attached = retry_status, retried
    step["result"] = "pass" if attach_status == 200 else "attach failed"
    if attach_status == 200:
        step["attached_ref"] = attached["session"]["ref"]
    return step


def close_and_reattach(http: Http, ref: dict[str, str], holder: dict[str, str]) -> dict[str, Any]:
    """Close one side of a fork pair and attach it again while `holder` still lives.

    The window OW-lajehi opened and OW-voyezi closed.  `DELETE` releases this
    session's share of the shared `codex app-server` but cannot kill it, and as
    of `codex-cli 0.154.0` nothing else releases the thread's writer lock --
    `thread/unsubscribe` answers `unsubscribed` and leaves it exactly where it
    was (`codex_unsubscribe_probe.py`).  So the attach has to come back to that
    same child; a fresh app-server would be refused.
    """
    step: dict[str, Any] = {"at": now(), "closed": ref, "still_open": holder}
    close_status, _ = http.request("DELETE", ref_path(ref))
    step["close_http"] = close_status
    # The close is answered before the adapter has finished letting go; nothing
    # observable marks that, so this waits rather than races it.
    time.sleep(2)
    status, body = http.json("GET", ref_path(ref))
    step["attach_http"] = status
    step["attach_body"] = body if status != 200 else {"ref": body["session"]["ref"]}
    step["result"] = "pass" if status == 200 else "reattach failed"
    return step


def run_backend(backend: str, workspace: Path, port: int, args: argparse.Namespace) -> dict[str, Any]:
    spec = BACKENDS[backend]
    http = Http(HOST, port)
    store_root = Path(spec["store_root"]).expanduser()
    # `finalize` removes what it is handed, so it is handed a scratch directory
    # this run owns and nothing else.  The backend stores above are the owner's
    # and are only ever read.
    scratch = Path(tempfile.mkdtemp(prefix=f"agentpane-forkattach-{backend}-", dir="/var/tmp"))
    server_log = Path(tempfile.mkstemp(prefix=f"agentpane-forkattach-{backend}-", suffix=".log")[1])
    server: subprocess.Popen[bytes] | None = None
    streams: list[SseReader] = []
    launched: set[int] = set()
    evidence: dict[str, Any] = {
        "backend": backend,
        "started_at": now(),
        "workspace": str(workspace),
        "model_pin": spec["model"],
        "version": subprocess.run(spec["version"], capture_output=True, text=True).stdout.strip(),
        "store_root": str(store_root),
        "steps": {},
    }
    exit_code = 1
    try:
        if not store_root.is_dir():
            raise RuntimeError(f"{backend} has no store at {store_root}")

        server = start_server(REPO, dict(os.environ, PORT=str(port)), server_log)
        evidence["server_pid"] = server.pid
        wait_for_built_client(http, server, 30)

        stream = SseReader(HOST, port)
        stream.start()
        streams.append(stream)

        create_status, created = http.json(
            "POST",
            "/api/sessions",
            {"cwd": str(workspace), "backend": backend, "model": spec["model"]},
        )
        if create_status != 201:
            raise RuntimeError(f"create failed: HTTP {create_status} {created}")
        ref = created["ref"]
        attach_status, attached = http.json("GET", ref_path(ref))
        if attach_status != 200:
            raise RuntimeError(f"attach failed: HTTP {attach_status} {attached}")
        ref = attached["session"]["ref"]
        evidence["steps"]["session"] = {"create_http": create_status, "ref": ref}

        # Two turns, so the last fork point is not also the first.
        first = turn(http, stream, ref, "Reply with exactly the word ONE and nothing else.", args.turn_timeout)
        evidence["steps"]["turn_one"] = first
        if first.get("result") != "pass":
            raise RuntimeError(f"the first turn never settled: {first}")
        ref = first["ref"]
        second = turn(http, stream, ref, "Reply with exactly the word TWO and nothing else.", args.turn_timeout)
        evidence["steps"]["turn_two"] = second
        if second.get("result") != "pass":
            raise RuntimeError(f"the second turn never settled: {second}")
        ref = second["ref"]
        evidence["steps"]["parent_transcript"] = transcript_of(stream, ref)

        # 1. The case the owner reports: edit the last message.
        forked = fork_at_last_point(http, stream, ref, backend=backend, store_root=store_root)
        evidence["steps"]["fork_last_turn"] = forked

        if forked.get("result") != "pass" and forked.get("fork_ref"):
            # Whose lock is it?  Codex 0.154.0 refuses a second writer on a
            # thread ("already has an active writer"), and the only other
            # candidate holder is the parent's own app-server process -- which
            # this closes, so a fork that attaches afterwards names it.
            close_status, _ = http.request("DELETE", ref_path(ref))
            time.sleep(2)
            retry_status, retried = http.json("GET", ref_path(forked["fork_ref"]))
            evidence["steps"]["attach_fork_after_closing_parent"] = {
                "close_http": close_status,
                "attach_http": retry_status,
                "attach_body": retried if retry_status != 200 else {"ref": retried["session"]["ref"]},
                "result": "pass" if retry_status == 200 else "attach failed",
            }

        if forked.get("result") == "pass":
            fork_ref = forked["attached_ref"]
            # 2. The prompt `forkAndSubmit` sends into the fork.
            third = turn(
                http, stream, fork_ref, "Reply with exactly the word THREE and nothing else.", args.turn_timeout
            )
            evidence["steps"]["fork_turn"] = third
            if third.get("result") == "pass":
                fork_ref = third["ref"]
                evidence["steps"]["fork_transcript"] = transcript_of(stream, fork_ref)

            # 3. Re-attach, now that the fork's own store file exists.
            again_status, again = http.json("GET", ref_path(fork_ref))
            evidence["steps"]["reattach_fork"] = {
                "http": again_status,
                "body": again if again_status != 200 else {"ref": again["session"]["ref"]},
            }

            # 4. Fork the fork at ITS most recent turn.
            evidence["steps"]["fork_of_fork"] = fork_at_last_point(
                http, stream, fork_ref, backend=backend, store_root=store_root
            )

            # 5. Close one side of the pair and re-attach it while the other
            #    still holds the shared child (OW-voyezi).
            if backend == "codex":
                evidence["steps"]["reattach_parent_after_closing_it"] = close_and_reattach(
                    http, ref, fork_ref
                )
                evidence["steps"]["reattach_fork_after_closing_it"] = close_and_reattach(
                    http, fork_ref, ref
                )

        # 6. And the parent a second time at the same point it was forked at.
        evidence["steps"]["parent_still_attaches"] = {"http": http.json("GET", ref_path(ref))[0]}
        evidence["steps"]["second_fork_of_parent"] = fork_at_last_point(
            http, stream, ref, backend=backend, store_root=store_root
        )

        failures = [
            name
            for name, step in evidence["steps"].items()
            if isinstance(step, dict) and step.get("result") not in (None, "pass")
        ]
        evidence["result"] = "pass" if not failures else "fail"
        evidence["failed_steps"] = failures
        exit_code = 0 if not failures else 1
    except Exception as exc:  # noqa: BLE001 -- the report is the product
        evidence["result"] = "error"
        evidence["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        # Before `finalize` deletes it: the backend's own complaint is here and
        # nowhere else, and it is the whole reason to run this.
        try:
            evidence["server_log_tail"] = server_log.read_text(errors="replace")[-4000:]
        except OSError:
            pass
        exit_code = finalize(
            evidence,
            exit_code,
            server=server,
            streams=streams,
            state_home=scratch,
            server_log=server_log,
            launched_workers=launched,
            worker_filter=worker_filter_for(backend),
        )
    evidence["exit_code"] = exit_code
    return evidence


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--backend", choices=tuple(BACKENDS), action="append", help="repeatable; default all three")
    ap.add_argument("--workspace", type=Path, default=REPO)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--turn-timeout", type=float, default=300.0)
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--out", type=Path, help="write the JSON report here as well as to stdout")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    workspace = args.workspace.expanduser().resolve()
    if not workspace.is_dir():
        raise SystemExit(f"workspace does not exist: {workspace}")
    backends = args.backend or list(BACKENDS)

    report: dict[str, Any] = {"started_at": now(), "workspace": str(workspace), "runs": {}}
    if not args.skip_build:
        report["build"] = build_client(REPO)
    for offset, backend in enumerate(backends):
        report["runs"][backend] = run_backend(backend, workspace, args.port + offset, args)
        time.sleep(1)
    report["result"] = (
        "pass" if all(run.get("result") == "pass" for run in report["runs"].values()) else "fail"
    )
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        args.out.write_text(text + "\n")
    return 0 if report["result"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
