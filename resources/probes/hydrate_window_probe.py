#!/usr/bin/env python3
"""What does the live stream carry while an adapter reads a session's history back? (OW-dutute)

D24's "Hydrate" paragraph makes every hydrate of a live session a merge, and
the shape of each merge turns on what the backend says in the window between
asking for the history and getting it.  This probe asks each CLI directly,
with no agentpane in the picture, and records every line in wire order.

  codex  A turn is started and gated on a streaming `agentMessage` (its
         `item/started` plus forty `item/agentMessage/delta`s), then the same
         connection sends what `CodexAdapter.startBorrowed` sends on a
         re-attach: `thread/resume` with `excludeTurns: true`, then
         `thread/turns/list` at `itemsView: "full"`.  Recorded: what the
         resume drew, and what the listing answered for the in-progress turn
         -- its status, its items, and how much of the streamed text the
         listed `agentMessage` carries against the deltas on the wire when the
         request went out and when its response arrived.  The listing is
         asked again after the turn completes, as the control.
  pi     Two turns, then a third that streams; gated on forty `text_delta`s as
         OW-sededi's cell is (`fork_probe.py`), then `fork` at that third
         turn's own user message, then the `get_state` and `get_messages`
         `PiAdapter.fork` sends.  Recorded: every line from the fork request to
         the `get_messages` response.  Then a second process resumes the
         abandoned file and sends what `PiAdapter.start` sends on a resume,
         `get_state` then `get_messages`, and every line of that is recorded
         too.

Usage:  python3 hydrate_window_probe.py --backend codex|pi [--json PATH]
Needs:  `codex` or `pi` on PATH with working credentials.  Each run makes
        real model calls on the pinned model (AGENTS.md, "Evidence"), in a
        throwaway state home and workspace.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from codex_fork_same_process_probe import CLIENT_INFO, MODEL as CODEX_MODEL, AppServer
from fork_probe import PI_STATE_FILES, PiSession, cli_version, make_state_home, make_workspace, text_of

PI_MODEL = "openrouter/deepseek/deepseek-v4.1-flash:high"
LONG_PROMPT = "Write the numbers 1 through 400, one per line, with no prose."
MIN_DELTAS = 40


# ----------------------------------------------------------------------------
# Codex
# ----------------------------------------------------------------------------

class SequencedAppServer(AppServer):
    """`AppServer`, with every line kept in arrival order beside the two maps it already keeps."""

    def __init__(self, cwd: str, env: dict[str, str], label: str) -> None:
        self.wire: list[dict[str, Any]] = []
        super().__init__(cwd, env, label)

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
                self.wire.append(event)
                if isinstance(event.get("id"), int) and ("result" in event or "error" in event):
                    self.responses[event["id"]] = event
                elif "method" in event:
                    self.notifications.append(event)

    def send(self, method: str, params: dict[str, Any]) -> int:
        with self.lock:
            self.next_id += 1
            request_id = self.next_id
        self.proc.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")  # type: ignore[union-attr]
        self.proc.stdin.flush()  # type: ignore[union-attr]
        return request_id

    def await_response(self, request_id: int, timeout: float = 60.0) -> tuple[dict[str, Any] | None, int]:
        """The response, and its position on the wire."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                for position, event in enumerate(self.wire):
                    if event.get("id") == request_id and ("result" in event or "error" in event):
                        return event, position
            time.sleep(0.02)
        return None, -1


def streamed_text(wire: list[dict[str, Any]], item_id: str) -> str:
    return "".join(
        e["params"]["delta"]
        for e in wire
        if e.get("method") == "item/agentMessage/delta" and e.get("params", {}).get("itemId") == item_id
    )


def census(lines: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in lines:
        key = e.get("method") or ("response" if "id" in e else "?")
        out[key] = out.get(key, 0) + 1
    return out


def item_summary(item: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"type": item.get("type"), "id": item.get("id")}
    if item.get("type") == "agentMessage":
        out["text_chars"] = len(item.get("text") or "")
    return out


def run_codex() -> dict[str, Any]:
    codex_home = make_state_home(Path.home() / ".codex", ("auth.json", "config.toml"), "agentpane-hydrate-codexhome-")
    workspace = make_workspace("agentpane-hydrate-codexwork-")
    env = dict(os.environ, CODEX_HOME=str(codex_home))
    report: dict[str, Any] = {"codex_version": cli_version("codex"), "model": CODEX_MODEL}
    server = SequencedAppServer(str(workspace), env, "codex")
    try:
        server.call("initialize", {"clientInfo": CLIENT_INFO, "capabilities": None})
        started = server.call("thread/start", {"cwd": str(workspace)})
        thread_id = started["result"]["thread"]["id"]
        server.call(
            "turn/start",
            {"threadId": thread_id, "model": CODEX_MODEL, "input": [{"type": "text", "text": LONG_PROMPT}]},
        )
        item_id = None
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with server.lock:
                wire = list(server.wire)
            if item_id is None:
                for e in wire:
                    item = e.get("params", {}).get("item", {}) if e.get("method") == "item/started" else {}
                    if item.get("type") == "agentMessage":
                        item_id = item["id"]
            if item_id and sum(
                1 for e in wire
                if e.get("method") == "item/agentMessage/delta" and e["params"].get("itemId") == item_id
            ) >= MIN_DELTAS:
                break
            if any(e.get("method") == "turn/completed" for e in wire):
                break
            time.sleep(0.05)
        report["agent_message_item"] = item_id

        def at(position: int) -> dict[str, Any]:
            with server.lock:
                wire = server.wire[:position]
            text = streamed_text(wire, item_id or "")
            return {
                "wire_position": position,
                "deltas": sum(1 for e in wire if e.get("method") == "item/agentMessage/delta"),
                "streamed_chars": len(text),
                "turn_completed": any(e.get("method") == "turn/completed" for e in wire),
            }

        with server.lock:
            resume_sent_at = len(server.wire)
        resume_id = server.send("thread/resume", {"threadId": thread_id, "cwd": str(workspace), "excludeTurns": True})
        resume, resume_at = server.await_response(resume_id)
        with server.lock:
            drawn = [e for e in server.wire[resume_sent_at:resume_at] if "method" in e]
        report["resume"] = {
            "ok": resume is not None and "result" in resume,
            "error": (resume or {}).get("error"),
            "sent": at(resume_sent_at),
            "answered": at(resume_at),
            "lines_between_census": census(drawn),
        }

        with server.lock:
            list_sent_at = len(server.wire)
        list_id = server.send(
            "thread/turns/list", {"threadId": thread_id, "sortDirection": "asc", "itemsView": "full"}
        )
        listing, list_at = server.await_response(list_id)
        turns = ((listing or {}).get("result") or {}).get("data") or []
        with server.lock:
            wire_now = list(server.wire)
        streamed_at_answer = streamed_text(wire_now[:list_at], item_id or "")
        listed_item = next(
            (i for t in turns for i in t.get("items") or [] if i.get("id") == item_id), None
        )
        listed_text = (listed_item or {}).get("text") if listed_item else None
        report["mid_turn_listing"] = {
            "ok": listing is not None and "result" in listing,
            "error": (listing or {}).get("error"),
            "sent": at(list_sent_at),
            "answered": at(list_at),
            "turns": [
                {"id": t.get("id"), "status": t.get("status"), "items": [item_summary(i) for i in t.get("items") or []]}
                for t in turns
            ],
            "streaming_item_listed": listed_item is not None,
            "listed_text_chars": len(listed_text) if listed_text is not None else None,
            "listed_text_is_prefix_of_streamed": (
                streamed_at_answer.startswith(listed_text) if listed_text is not None else None
            ),
        }

        completed = server.wait_for_turn_end(timeout=180)
        report["turn_status"] = (completed or {}).get("turn", {}).get("status")
        final = server.call("thread/turns/list", {"threadId": thread_id, "sortDirection": "asc", "itemsView": "full"})
        final_turns = (final.get("result") or {}).get("data") or []
        report["after_turn_listing"] = [
            {"id": t.get("id"), "status": t.get("status"), "items": [item_summary(i) for i in t.get("items") or []]}
            for t in final_turns
        ]
        with server.lock:
            report["streamed_chars_total"] = len(streamed_text(server.wire, item_id or ""))
    finally:
        server.close()
        shutil.rmtree(codex_home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)
    return report


# ----------------------------------------------------------------------------
# Pi
# ----------------------------------------------------------------------------

class PinnedPiSession(PiSession):
    """`fork_probe.PiSession`, spawned with the model flag AGENTS.md makes mandatory, and optionally on a session file."""

    def __init__(self, work: Path, home: Path, sessdir: Path, session: str | None = None) -> None:
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(home))
        args = ["pi", "--mode", "rpc", "--session-dir", str(sessdir), "--model", PI_MODEL]
        if session:
            args += ["--session", session]
        self.proc = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, cwd=work, env=env,
        )
        self.lock = threading.Lock()
        self.raw = []
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()

    def line_kinds(self, start: int, end: int | None = None) -> list[str]:
        """Each line in [start, end) named by its type, a delta by its kind, a response by its command."""
        out = []
        for line in self.raw[start:end]:
            try:
                e = json.loads(line)
            except ValueError:
                out.append("<non-json>")
                continue
            kind = e.get("type")
            if kind == "response":
                kind = f"response:{e.get('command')}"
            elif kind == "message_update":
                kind = f"message_update:{(e.get('assistantMessageEvent') or {}).get('type')}"
            elif kind in ("message_start", "message_end"):
                kind = f"{kind}:{(e.get('message') or {}).get('role')}"
            out.append(kind)
        return out

    def position_of_response(self, command: str, since: int) -> int:
        for position, line in enumerate(self.raw[since:], start=since):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "response" and e.get("command") == command:
                return position
        return -1


def collapse(kinds: list[str]) -> list[str]:
    """Runs of one kind as `kind x N`, so forty deltas read as one entry."""
    out: list[str] = []
    for kind in kinds:
        if out and out[-1].split(" x ")[0] == kind:
            head, _, count = out[-1].partition(" x ")
            out[-1] = f"{head} x {int(count or 1) + 1}"
        else:
            out.append(kind)
    return out


def run_pi() -> dict[str, Any]:
    work = make_workspace("agentpane-hydrate-piwork-")
    home = make_state_home(Path.home() / ".pi" / "agent", PI_STATE_FILES, "agentpane-hydrate-pihome-")
    sessdir = work / "sessions"
    report: dict[str, Any] = {"pi_version": cli_version("pi"), "model_flag": PI_MODEL}
    pi = PinnedPiSession(work, home, sessdir)
    abandoned_file = None
    try:
        state = pi.response({"type": "get_state"}, "get_state")["data"]
        report["model_in_force"] = f"{(state.get('model') or {}).get('provider')}/{(state.get('model') or {}).get('id')}"
        report["thinking_level"] = state.get("thinkingLevel")
        pi.turn("Say exactly: ALPHA")
        pi.turn("Say exactly: BETA")

        stream_mark = len(pi.raw)
        pi.response({"type": "prompt", "message": LONG_PROMPT}, "prompt")
        streaming = pi.await_streaming(stream_mark, min_deltas=MIN_DELTAS, timeout=120)
        forks = pi.response({"type": "get_fork_messages"}, "get_fork_messages")["data"]["messages"]
        state_before = pi.response({"type": "get_state"}, "get_state")["data"]
        abandoned_file = state_before.get("sessionFile")
        entry = forks[-1]["entryId"] if forks else None
        deltas_at_fork, _ = pi.stream_deltas(stream_mark)
        report["fork"] = {
            "streaming_confirmed": streaming["streaming_confirmed"],
            "deltas_at_the_fork_itself": deltas_at_fork,
            "still_streaming_at_the_fork_itself": pi.still_streaming(stream_mark),
            "fork_entry_text": forks[-1]["text"] if forks else None,
            "message_count_before": state_before.get("messageCount"),
        }
        fork_sent = len(pi.raw)
        pi.send({"id": "fork", "type": "fork", "entryId": entry})
        deadline = time.time() + 30
        while pi.position_of_response("fork", fork_sent) < 0 and time.time() < deadline:
            time.sleep(0.05)
        fork_answered = pi.position_of_response("fork", fork_sent)
        pi.send({"id": "state", "type": "get_state"})
        pi.send({"id": "messages", "type": "get_messages"})
        deadline = time.time() + 30
        while pi.position_of_response("get_messages", fork_sent) < 0 and time.time() < deadline:
            time.sleep(0.05)
        messages_answered = pi.position_of_response("get_messages", fork_sent)
        time.sleep(3)  # anything still to come from the abandoned turn
        messages = json.loads(pi.raw[messages_answered])["data"]["messages"]
        report["fork"].update({
            "lines_fork_sent_to_fork_answered": collapse(pi.line_kinds(fork_sent, fork_answered + 1)),
            "lines_fork_answered_to_get_messages_answered": collapse(
                pi.line_kinds(fork_answered + 1, messages_answered + 1)
            ),
            "lines_in_the_3s_after": collapse(pi.line_kinds(messages_answered + 1)),
            "get_messages_answer": [
                {"role": m.get("role"), "text": text_of(m)[:40]} for m in messages
            ],
        })
    finally:
        pi.close()

    if abandoned_file:
        resumed = PinnedPiSession(work, home, sessdir, session=abandoned_file)
        try:
            resumed.send({"id": "state", "type": "get_state"})
            resumed.send({"id": "messages", "type": "get_messages"})
            deadline = time.time() + 30
            while resumed.position_of_response("get_messages", 0) < 0 and time.time() < deadline:
                time.sleep(0.05)
            state_at = resumed.position_of_response("get_state", 0)
            messages_at = resumed.position_of_response("get_messages", 0)
            time.sleep(3)
            report["resume"] = {
                "lines_before_get_state_answered": collapse(resumed.line_kinds(0, state_at)),
                "lines_get_state_to_get_messages": collapse(resumed.line_kinds(state_at + 1, messages_at)),
                "lines_in_the_3s_after": collapse(resumed.line_kinds(messages_at + 1)),
                "message_count": len(json.loads(resumed.raw[messages_at])["data"]["messages"]),
            }
        finally:
            resumed.close()
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=("codex", "pi"), required=True)
    ap.add_argument("--json", type=Path, help="write the report here as well as to stdout")
    args = ap.parse_args()
    report = run_codex() if args.backend == "codex" else run_pi()
    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        args.json.write_text(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
