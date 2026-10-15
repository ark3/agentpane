#!/usr/bin/env python3
"""What a Pi fork before the first assistant reply answers, and when a new
session's file and a fork's file reach disk (OW-tigaye).

Read at the installed source, not run, before this probe: as of `pi 0.87.1`
a session's file was first written once an assistant message existed
(`docs/MANUAL_TESTING.md`, OW-bohodu), the runtime's `fork` refuses a branch
whose current file is not on disk ("This session has not been saved yet"),
and `createBranchedSession` defers writing a branch that keeps no
conversation. `pi 0.99.0`'s CHANGELOG says the file is now created when the
first user message is sent. The server's fork route aborts nothing before it
forks, so a raw request during a first turn reaches whatever Pi answers.

## Part `rpc`: Pi alone

`pi --mode rpc --session-dir <scratch>/sessions --model <pinned>`, read raw
through `PiRpc` from `agentpane_pi_prompt_window_probe.py`, whose reader
thread calls a hook on every parsed line; the hook stats files there, so a
sample is taken the moment the line is parsed, not after a round trip.

* `before_prompt`: `get_state`'s `sessionFile` and whether it exists, then
  `get_fork_messages`, `get_entries`, a `fork` at an id no entry has, a `fork`
  at each setup entry `get_entries` names, and `clone`, each answer recorded.
* `first_turn`: one long prompt; on every line, whether the session file
  exists. After the user `message_end`, `get_fork_messages` names the first
  user message, and the hook writes `fork` at it the instant the
  `FORK_AT_DELTAS`th `text_delta` is parsed. On the `fork` response the hook
  lists the session directory. Then `get_state`, and both files' entries.
* `fork_turns`: two short turns on that fork, the file sampled on every line
  of the first; then a `fork` at the second user message and, on the branch
  that leaves, a `fork` at the first, each with the directory listed at the
  response.

## Part `agentpane`: through the built server

The real chain, `direnv exec <workspace> sbox -- pi --mode rpc --model
<pinned>` spawned by the built server, with a `pi` shim first on its PATH
that tees Pi's stdin and stdout to two tap files (as the prompt-window
probe's). Sessions are created and attached over REST and followed on SSE.

* `fork_before_prompt`: `fork-points`, then `POST .../fork` with an id no
  entry has, then the session's summary and a re-attach.
* `fork_first_turn`: a long prompt; once the turn's assistant text passes
  `FORK_AT_CHARS` with the session still streaming, `fork-points` and
  `POST .../fork` at the first user message. The returned ref's file is
  stat'ed the moment the response is read. Then an attach of the fork and a
  short turn on it, with the fork's file read before and after.

Nothing after a fork asks the session index or re-attaches the parent:
the relocated `PI_CODING_AGENT_DIR` moves Pi's store and not the server's,
which walks `~/.pi/agent/sessions` whatever the variable says
(`src/server/sessions/index.ts`), so the index cannot see a file this run
writes, and a re-attach of the parent answered 404 on a first pass with its
file on disk -- the harness defect `docs/MANUAL_TESTING.md` records in
"Forking the most recent turn and attaching the fork, on all three backends
(OW-lajehi)". The listing rows read before any prompt and as the fork
attaches are the manager's own, for sessions still attached.

The Emacs helper's `sessions/fork` is a pass-through to the same route
(`src/emacs/helper.ts`, `toRpcError`), so it is not driven here.

## The configuration

As `agentpane_pi_prompt_window_probe.py`'s: `PI_CODING_AGENT_DIR` is a
temporary copy of `~/.pi/agent` holding the credential and settings files by
name and `extensions/` dereferenced; the workspace is a fresh directory under
`/var/tmp` carrying only `.sandbox-workspace`. Every model call is pinned by
`--model` (AGENTS.md). This makes real model calls, never invokes Codex or
Claude, copies Pi credentials by name without reading them, and signals only
pids it recorded as its own.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from agentpane_live_support import (
    LONG_PROMPT,
    Http,
    SseReader,
    assistant_text,
    build_client,
    descendants,
    finalize,
    last_streaming,
    now,
    ref_path,
    start_server,
    transcript,
    wait_for_built_client,
)
from agentpane_pi_prompt_window_probe import (
    PINNED_MODEL,
    PiRpc,
    make_pi_home,
    make_shim,
    make_workspace,
    pi_workers,
    read_tap,
    sse_rows,
    summarise,
    word,
)

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 44178
FORK_AT_DELTAS = 30
FORK_AT_CHARS = 300
NO_SUCH_ENTRY = "no-such-entry"


def entries_of(path: Path | None) -> dict[str, Any]:
    """A session file as its entry kinds, assistant text lengths alongside."""
    if path is None or not path.exists():
        return {"exists": False}
    rows = []
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        kind = entry.get("type", "?")
        if kind == "message":
            message = entry.get("message") or {}
            role = message.get("role")
            kind = f"message:{role}"
            if role == "assistant":
                kind += f"({len(assistant_text(message))})"
        rows.append(kind)
    return {"exists": True, "bytes": path.stat().st_size, "entries": rows}


def listing(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.rglob("*.jsonl")) if directory.exists() else []


# ---------------------------------------------------------------------------
# part rpc
# ---------------------------------------------------------------------------


def run_rpc(args: argparse.Namespace, pi: str, home: Path, workspace: Path) -> dict[str, Any]:
    sessions = Path(tempfile.mkdtemp(prefix="agentpane-tigaye-sessions-", dir="/var/tmp"))
    rpc = PiRpc(pi, args.model, home, workspace, ("--session-dir", str(sessions)))
    out: dict[str, Any] = {"command": [pi, "--mode", "rpc", "--session-dir", "<scratch>", "--model", args.model]}

    def ask(command: dict[str, Any], timeout: float = 60) -> dict[str, Any]:
        mark = len(rpc.snapshot())
        rpc.write(command)
        return rpc.wait(rpc.response(mark, command["id"]), timeout, command["id"])["event"]

    def state(tag: str) -> dict[str, Any]:
        data = ask({"id": f"state-{tag}", "type": "get_state"})["data"]
        return {
            "model": f"{data['model']['provider']}/{data['model']['id']}" if data.get("model") else None,
            "thinkingLevel": data.get("thinkingLevel"),
            "isStreaming": data.get("isStreaming"),
            "messageCount": data.get("messageCount"),
            "sessionFile": data.get("sessionFile"),
        }

    def answer(event: dict[str, Any]) -> dict[str, Any]:
        return {k: event.get(k) for k in ("success", "data", "error")}

    try:
        # -- before any prompt ---------------------------------------------------
        before: dict[str, Any] = {"get_state": state("0")}
        file0 = Path(before["get_state"]["sessionFile"])
        before["file_exists"] = file0.exists()
        before["get_fork_messages"] = ask({"id": "fm0", "type": "get_fork_messages"})["data"]
        entries = ask({"id": "en0", "type": "get_entries"})
        before["get_entries"] = [
            {"id": e.get("id"), "type": e.get("type"), "role": (e.get("message") or {}).get("role")}
            for e in (entries.get("data") or {}).get("entries", [])
        ] if entries.get("success") else answer(entries)
        before["fork_no_such_entry"] = answer(ask({"id": "fk0", "type": "fork", "entryId": NO_SUCH_ENTRY}))
        before["fork_setup_entries"] = [
            {"entry": e, **answer(ask({"id": f"fk0-{e['id']}", "type": "fork", "entryId": e["id"]}))}
            for e in (before["get_entries"] if isinstance(before["get_entries"], list) else [])
        ]
        before["clone"] = answer(ask({"id": "cl0", "type": "clone"}))
        before["get_state_after"] = state("0b")
        before["file_exists_after"] = file0.exists()
        before["sessions_dir"] = listing(sessions)
        out["before_prompt"] = before

        # -- the first turn, forked mid-stream at its first user message ------------
        start = len(rpc.snapshot())
        samples: list[dict[str, Any]] = []
        seen_updates: set[str] = set()
        # `text_deltas` counts on until the fork response clears the hook;
        # `text_deltas_at_fork_write` is the count the fork went out at.
        record: dict[str, Any] = {"text_deltas": 0}

        def hook(row: dict[str, Any]) -> None:
            event = row["event"]
            kind = event.get("type")
            if kind == "message_update":
                sub = (event.get("assistantMessageEvent") or {}).get("type", "?")
                if sub == "text_delta":
                    record["text_deltas"] += 1
                    if record["text_deltas"] >= FORK_AT_DELTAS and "entry" in record and "fork_written_at" not in record:
                        record["text_deltas_at_fork_write"] = record["text_deltas"]
                        record["assistant_message_end_seen_at_fork"] = record.get("assistant_end_at") is not None
                        record["fork_written_at"] = rpc.write({"id": "fk1", "type": "fork", "entryId": record["entry"]})
                        record["file_exists_at_fork_write"] = file0.exists()
                if sub in seen_updates:
                    return
                seen_updates.add(sub)
                kind = f"message_update:{sub}"
            if kind in ("message_start", "message_end"):
                kind = f"{kind}:{(event.get('message') or {}).get('role')}"
            if kind == "message_end:assistant" and "assistant_end_at" not in record:
                record["assistant_end_at"] = row["t"]
            if kind == "response" and event.get("id") == "fk1":
                record["sessions_dir_at_fork_response"] = listing(sessions)
                record["parent_exists_at_fork_response"] = file0.exists()
            if kind == "response":
                kind = f"response:{event.get('command')}"
            if "fork_response_t" not in record:
                samples.append({"t": row["t"], "line": kind, "file_exists": file0.exists()})
            if kind == "response:fork":
                record["fork_response_t"] = row["t"]

        rpc.on_line = hook
        sent = rpc.write({"id": "p1", "type": "prompt", "message": LONG_PROMPT})
        samples.append({"t": sent, "line": "<prompt written>", "file_exists": file0.exists()})
        rpc.wait(lambda rows: any(
            r["event"].get("type") == "message_end" and (r["event"].get("message") or {}).get("role") == "user"
            for r in rows[start:]
        ), 60, "the user message_end")
        points = ask({"id": "fm1", "type": "get_fork_messages"})["data"]["messages"]
        record["fork_points_during_turn"] = points
        record["entry"] = points[0]["entryId"]
        fork = rpc.wait(rpc.response(start, "fk1"), 240, "the mid-turn fork's response")
        rpc.on_line = None
        record["fork_response"] = answer(fork["event"])
        after = state("1")
        rpc.settle(start)
        rows = rpc.snapshot()
        fork_index = next(i for i, r in enumerate(rows) if r["event"].get("id") == "fk1" and r["event"].get("type") == "response")
        written_index = next(i for i, r in enumerate(rows[start:], start) if r["t"] >= record["fork_written_at"])
        record.update({
            "get_state_after": after,
            "lines_between_fork_write_and_response": [
                summarise(r["event"]) for r in rows[written_index:fork_index] if r["event"].get("type") != "message_update"
            ],
            "lifecycle_after_response": [
                summarise(r["event"]) for r in rows[fork_index + 1:] if r["event"].get("type") != "message_update"
            ],
            "parent_file": entries_of(file0),
            "fork_file": entries_of(Path(after["sessionFile"])),
            "file_samples": samples,
        })
        record.pop("entry")
        out["first_turn"] = record

        # -- turns on the fork, then forks at its second and first user messages --
        file1 = Path(after["sessionFile"])
        turns: dict[str, Any] = {"fork_points_before": ask({"id": "fm2", "type": "get_fork_messages"})["data"]}
        start = len(rpc.snapshot())
        samples = []

        def sample(row: dict[str, Any]) -> None:
            event = row["event"]
            if event.get("type") == "message_update":
                return
            kind = event.get("type")
            if kind in ("message_start", "message_end"):
                kind = f"{kind}:{(event.get('message') or {}).get('role')}"
            samples.append({"t": row["t"], "line": kind, "file_exists": file1.exists()})

        rpc.on_line = sample
        rpc.write({"id": "p2", "type": "prompt", "message": word("ALPHA")})
        rpc.settle(start)
        rpc.on_line = None
        turns["first_turn_file_samples"] = samples
        start = len(rpc.snapshot())
        rpc.write({"id": "p3", "type": "prompt", "message": word("BRAVO")})
        rpc.settle(start)
        turns["file_after_two_turns"] = entries_of(file1)
        points = ask({"id": "fm3", "type": "get_fork_messages"})["data"]["messages"]

        def fork_at(tag: str, entry: str, base: Path) -> dict[str, Any]:
            cell: dict[str, Any] = {}

            def at_response(row: dict[str, Any]) -> None:
                event = row["event"]
                if event.get("type") == "response" and event.get("id") == f"fk-{tag}":
                    cell["sessions_dir_at_response"] = listing(sessions)

            before_listing = listing(sessions)
            rpc.on_line = at_response
            cell["response"] = answer(ask({"id": f"fk-{tag}", "type": "fork", "entryId": entry}))
            rpc.on_line = None
            cell["new_files_at_response"] = sorted(set(cell.pop("sessions_dir_at_response", [])) - set(before_listing))
            cell["get_state"] = state(tag)
            moved = Path(cell["get_state"]["sessionFile"])
            cell["moved_to_file_exists_after_get_state"] = moved.exists()
            cell["moved_to_file"] = entries_of(moved)
            cell["forked_from_file_unchanged"] = entries_of(base)
            return cell

        turns["fork_at_second"] = fork_at("second", points[1]["entryId"], file1)
        file2 = Path(turns["fork_at_second"]["get_state"]["sessionFile"])
        first_points = ask({"id": "fm4", "type": "get_fork_messages"})["data"]["messages"]
        turns["fork_at_first"] = fork_at("first", first_points[0]["entryId"], file2)
        out["fork_turns"] = turns
        out["sessions_dir_final"] = listing(sessions)
    finally:
        rpc.on_line = None
        rpc.close()
        shutil.rmtree(sessions, ignore_errors=True)
    return out


# ---------------------------------------------------------------------------
# part agentpane
# ---------------------------------------------------------------------------


def run_agentpane(args: argparse.Namespace, pi: str, home: Path, workspace: Path, repo: Path) -> dict[str, Any]:
    http = Http(HOST, args.port)
    tap_in = Path(tempfile.mkstemp(prefix="agentpane-tigaye-in-", suffix=".jsonl", dir="/tmp")[1])
    tap_out = Path(tempfile.mkstemp(prefix="agentpane-tigaye-out-", suffix=".jsonl", dir="/tmp")[1])
    shim_dir = make_shim(Path(pi).resolve(), tap_in, tap_out)
    server_log = Path(tempfile.mkstemp(prefix="agentpane-tigaye-server-", suffix=".log")[1])
    scratch = Path(tempfile.mkdtemp(prefix="agentpane-tigaye-scratch-", dir="/var/tmp"))
    server = None
    streams: list[SseReader] = []
    launched: set[int] = set()
    out: dict[str, Any] = {}
    exit_code = 1

    def pi_lines(start: int, kinds: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        return [summarise(e) for e in read_tap(tap_out)[start:]
                if e.get("type") != "message_update" and (kinds is None or e.get("type") in kinds)]

    try:
        if not args.skip_build:
            out["build"] = build_client(repo)
        server = start_server(
            repo,
            dict(os.environ, PATH=f"{shim_dir}{os.pathsep}{os.environ['PATH']}",
                 PI_CODING_AGENT_DIR=str(home), PORT=str(args.port)),
            server_log,
        )
        wait_for_built_client(http, server, 30)
        stream = SseReader(HOST, args.port)
        stream.start()
        streams.append(stream)

        def track() -> None:
            launched.update(row["pid"] for row in pi_workers(descendants(server.pid)))

        def summary(ref: dict[str, str]) -> dict[str, Any] | None:
            status, body = http.json("GET", f"/api/sessions?cwd={workspace}")
            for row in (body or {}).get("sessions", []):
                if row["ref"] == ref:
                    return {k: row.get(k) for k in ("status", "isStreaming", "onDisk", "preview")}
            return None

        def attach(ref: dict[str, str]) -> dict[str, Any]:
            status, body = http.json("GET", ref_path(ref))
            track()
            session = (body or {}).get("session") or {}
            return {"status": status, "ref": session.get("ref"), "handle": session.get("handle"),
                    "isStreaming": session.get("isStreaming"), "onDisk": session.get("onDisk"),
                    **({} if status == 200 else {"body": body})}

        def idle(handle: str, start: int, timeout: float = 120) -> None:
            def seen(events: list[tuple[str, dict[str, Any]]]) -> Any:
                saw = False
                for _, e in events[start:]:
                    if e.get("handle") == handle and e.get("type") in ("snapshot", "status"):
                        if e.get("isStreaming"):
                            saw = True
                        elif saw:
                            return True
                return None
            stream.wait_for(seen, timeout, "the session to stream and go idle")
            time.sleep(2)

        # -- a session, forked before its first prompt --------------------------------
        status, created = http.json("POST", "/api/sessions", {"cwd": str(workspace), "backend": "pi", "model": args.model})
        if status != 201:
            raise RuntimeError(f"create failed: HTTP {status} {created}")
        first = attach(created["ref"])
        ref, handle = first["ref"], first["handle"]
        out["attach"] = {**first, "file_exists": Path(ref["id"]).exists()}
        out["model_on_wire"] = next((e.get("model") for _, e in reversed(stream.snapshot())
                                     if e.get("handle") == handle and e.get("model")), None)
        time.sleep(2)

        cell: dict[str, Any] = {}
        sse0, tap0 = len(stream.snapshot()), len(read_tap(tap_out))
        cell["fork_points"] = http.json("GET", ref_path(ref, "/fork-points"))
        cell["fork"] = dict(zip(("status", "body"), http.json("POST", ref_path(ref, "/fork"), {"entryId": NO_SUCH_ENTRY})))
        time.sleep(2)
        cell["pi_stdout"] = pi_lines(tap0)
        cell["sse"] = sse_rows(stream.snapshot(), sse0, handle)
        cell["summary_after"] = summary(ref)
        cell["reattach"] = attach(ref)
        cell["file_exists_after"] = Path(ref["id"]).exists()
        out["fork_before_prompt"] = cell

        # -- the same session, forked during its first turn ----------------------------
        cell = {}
        sse0, tap0 = len(stream.snapshot()), len(read_tap(tap_out))
        status, body = http.json("POST", ref_path(ref, "/prompt"), {"text": LONG_PROMPT})
        cell["prompt"] = {"status": status, "body": body}

        def far_enough(events: list[tuple[str, dict[str, Any]]]) -> Any:
            if last_streaming(events, handle) is not True:
                return None
            chars = sum(len(assistant_text(m)) for m in transcript(events, handle))
            return chars if chars >= FORK_AT_CHARS else None

        cell["assistant_chars_before_fork_points"] = stream.wait_for(far_enough, 180, "the first turn's text")
        status, points = http.json("GET", ref_path(ref, "/fork-points"))
        cell["fork_points"] = {"status": status, "body": points}
        cell["assistant_message_end_on_wire_before_fork"] = any(
            e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant"
            for e in read_tap(tap_out)[tap0:]
        )
        cell["parent_exists_before_fork"] = Path(ref["id"]).exists()
        sent = time.monotonic()
        status, forked = http.json("POST", ref_path(ref, "/fork"), {"entryId": points["points"][0]["id"]})
        fork_ref = (forked or {}).get("ref")
        cell["fork"] = {
            "status": status,
            "body": forked,
            "seconds": round(time.monotonic() - sent, 3),
            "fork_file_exists_at_response": bool(fork_ref) and Path(fork_ref["id"]).exists(),
            "parent_file_at_response": entries_of(Path(ref["id"])),
        }
        time.sleep(3)
        cell["pi_stdout_from_prompt"] = pi_lines(tap0, ("response", "agent_start", "agent_end", "agent_settled",
                                                         "message_start", "message_end"))
        cell["sse_parent_handle"] = sse_rows(stream.snapshot(), sse0, handle)
        out["fork_first_turn"] = cell
        if status != 201 or not fork_ref:
            raise RuntimeError(f"fork failed: HTTP {status} {forked}")

        after: dict[str, Any] = {
            "fork_file_after_3s": entries_of(Path(fork_ref["id"])),
            "fork_summary": summary(fork_ref),
        }
        attached = attach(fork_ref)
        fork_handle = attached["handle"]
        after["attach_fork"] = attached
        after["fork_transcript_roles"] = [m.get("role") for m in transcript(stream.snapshot(), fork_handle)]
        sse0 = len(stream.snapshot())
        status, body = http.json("POST", ref_path(fork_ref, "/prompt"), {"text": word("ALPHA")})
        after["fork_prompt"] = {"status": status, "body": body}
        idle(fork_handle, sse0)
        after["fork_file_after_turn"] = entries_of(Path(fork_ref["id"]))
        fork_sse = sse_rows(stream.snapshot(), sse0, fork_handle)
        after["fork_sse_errors"] = [r for r in fork_sse if r["type"] == "error"]
        after["fork_sse_notices"] = [r for r in fork_sse if r["type"] == "notice"]
        after["parent_file_final"] = entries_of(Path(ref["id"]))
        out["after_fork"] = after
        exit_code = 0
    except Exception as error:
        out["error"] = f"{type(error).__name__}: {error}"
        if server_log.exists():
            out["server_log_tail"] = server_log.read_text(errors="replace")[-4000:]
    finally:
        if server_log.exists():
            out["server_log_fork_lines"] = [
                line for line in server_log.read_text(errors="replace").splitlines() if "fork" in line.lower()
            ][-20:]
        cleanup: dict[str, Any] = {}
        finalize(cleanup, exit_code, server=server, streams=streams, state_home=scratch, server_log=server_log,
                 launched_workers=launched, worker_filter=pi_workers)
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
        "probe": "agentpane_pi_fork_first_turn_probe.py",
        "card": "OW-tigaye",
        "commit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip(),
        "pi_version": subprocess.run([pi, "--version"], capture_output=True, text=True, check=True).stdout.strip(),
        "model_flag": args.model,
        "copied_state_files": copied,
        "copied_extensions": extensions,
    }
    code = 0
    try:
        if "auth.json" not in copied:
            raise SystemExit(f"missing Pi credentials under {args.credential_source}")
        if args.part in ("rpc", "both"):
            evidence["rpc"] = run_rpc(args, pi, home, workspace)
        if args.part in ("agentpane", "both"):
            evidence["agentpane"] = run_agentpane(args, pi, home, workspace, repo)
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
