#!/usr/bin/env python3
"""What a Pi fork before the first assistant reply answers, and when a new
session's file and a fork's file reach disk (OW-tigaye).

Read at the installed source, not run, before this probe: as of `pi 0.87.1`
a session's file was first written once an assistant message existed
(`docs/MANUAL_TESTING.md`, OW-bohodu), the runtime's `fork` refuses a branch
whose current file is not on disk ("This session has not been saved yet"),
and `createBranchedSession` defers writing a branch that keeps no
conversation. `pi 0.99.0`'s CHANGELOG says the file is now created when the
first user message is sent.

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

## Part `agentpane`: moved

The `agentpane` part, through the built server, is
`agentpane_pi_fork_first_turn_probe.ts`, over the socket and with
fork-and-prompt (D30), since ark3/agentpane#54 retired the HTTP command routes
and the event stream.

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
import datetime as dt
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from agentpane_pi_prompt_window_probe import (
    PINNED_MODEL,
    PiRpc,
    make_pi_home,
    make_workspace,
    summarise,
    word,
)

REPO = Path(__file__).resolve().parents[2]
FORK_AT_DELTAS = 30
NO_SUCH_ENTRY = "no-such-entry"
# The smoke probes' handbook prompt, which the pinned model writes at length.
LONG_PROMPT = (
    "Do not use tools. Write a long, detailed handbook on growing vegetables in a home garden. "
    "Write twenty chapters, each under its own title and each at least 400 words long, covering in order: "
    "planning the plot, soil testing, soil preparation, raised beds, choosing varieties, starting seeds indoors, "
    "transplanting, direct sowing, watering, mulching, sunlight and siting, fertilising, composting, "
    "companion planting, pest control, disease control, weeding, crop rotation, harvesting, and storing the harvest. "
    "Write every chapter in full and do not summarise or abbreviate any of them."
)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="milliseconds")


def assistant_text(message: dict[str, Any]) -> str:
    if message.get("role") != "assistant":
        return ""
    return "".join(
        block.get("text", "")
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app-root", type=Path, default=REPO)
    parser.add_argument("--model", default=PINNED_MODEL, help="model ref for Pi's --model (default: AGENTS.md's pin)")
    parser.add_argument("--credential-source", type=Path, default=Path.home() / ".pi" / "agent")
    parser.add_argument(
        "--part", choices=("rpc",), default="rpc",
        help="the only part left; the agentpane part is agentpane_pi_fork_first_turn_probe.ts",
    )
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
        evidence["rpc"] = run_rpc(args, pi, home, workspace)
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
