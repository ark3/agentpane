#!/usr/bin/env python3
"""Capture raw protocol fixtures from Pi and Codex for offline adapter tests.

The two probe scripts next to this one *prove* each protocol works. This one
*records* it: every line each backend emits, byte-for-byte apart from a scrub
pass, into `resources/fixtures/<backend>/<scenario>.jsonl`, plus a
`.meta.json` with the CLI version and an event-type census.

The scrub replaces values that identify the operator's infrastructure --
model ids, provider names, an MCP server name that is really a hostname, and
a user agent carrying OS and terminal versions -- because these fixtures get
committed. See SCRUB_KEYS. Use `--no-scrub` for local debugging only.

Those fixtures are what let the `ThreadItem` -> `AgentMessage` mapping (the
only real engineering in this project, see docs/DESIGN.md) be built and tested
without live model calls.

Usage:
    python3 capture_fixtures.py                     # all backends, all scenarios
    python3 capture_fixtures.py --backend codex     # one backend
    python3 capture_fixtures.py --scenario tool-edit
    python3 capture_fixtures.py --timeout 180

Needs: `pi` and/or `codex` on PATH with working credentials. Each scenario is
a live model call, so this costs tokens and takes tens of seconds.

Two things this script has to work around, both learned the hard way:

1. **Both agents need a writable state directory.** Pi wants to take a lock
   under `~/.pi/agent` just to *read* its credential store; Codex wants a
   sqlite state runtime under `~/.codex`. Both of those are read-only when
   this repo's own session is sandboxed, and an inner `sbox` cannot escalate
   what the outer namespace mounted read-only. So each backend gets a
   throwaway state dir (`PI_CODING_AGENT_DIR` / `CODEX_HOME`) with its real
   credentials copied in. Without this you get a turn that "succeeds" in 0.7s
   with `stopReason: "error"` and empty content.

2. **Blocking dialogs would hang the capture.** Pi can emit
   `extension_ui_request` and Codex can emit a `ServerRequest`; both wait for
   an answer. We answer them and record that they happened -- whether Codex's
   approval requests fire at all is an open question in DESIGN D2a.

We deliberately do *not* spawn through sbox here. sbox cannot fix (1) in a
nested sandbox, and the protocol is sbox-transparent over stdio (HANDOFF fact
8), so the captured bytes are identical either way. Production spawns through
sbox per D7; fixtures do not need to.

Neither backend's real session store is polluted: Pi runs with `--no-session`,
and Codex threads are started with `ephemeral: true`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"

# Each scenario is a prepared workspace plus one prompt. They are chosen to
# exercise the mapping rows in DESIGN that actually differ: plain streaming
# text, a tool call/result pair, and a file edit (which is the diff path).
SCENARIOS: dict[str, dict] = {
    "text": {
        "prompt": "Reply with exactly: hello there friend",
        "files": {},
        "covers": "streaming text deltas, no tools",
    },
    "tool-read": {
        "prompt": "Read greeting.txt and tell me, in one short sentence, what it says.",
        "files": {"greeting.txt": "The quick brown fox jumps over the lazy dog.\n"},
        "covers": "tool call + tool result pair",
    },
    "tool-edit": {
        "prompt": "Append a single line saying 'goodbye' to greeting.txt. Do not ask for confirmation.",
        "files": {"greeting.txt": "The quick brown fox jumps over the lazy dog.\n"},
        "covers": "file change / diff rendering path",
    },
}


# Copied into the throwaway PI_CODING_AGENT_DIR. Credentials plus the model
# catalogue and trust state -- enough for a turn, without the AGENTS.md and
# scratch notes that live alongside them and would add noise to the fixture.
PI_STATE_FILES = ("auth.json", "models.json", "models-store.json",
                  "settings.json", "trust.json")
CODEX_STATE_FILES = ("auth.json", "config.toml")


def make_state_home(real_dir: Path, names: tuple[str, ...], prefix: str) -> Path:
    home = Path(tempfile.mkdtemp(prefix=prefix))
    for name in names:
        src = real_dir / name
        if src.exists():
            shutil.copy(src, home / name)
    return home


# Values at these JSON keys identify the operator's infrastructure -- internal
# provider names, gov-cloud model ids, an MCP server that is really a machine
# hostname, a user agent carrying OS and terminal versions. Fixtures get
# committed, so they are replaced with structurally-equivalent placeholders.
# Tool names are deliberately NOT in this list: tests need `bash`, `read`, etc.
SCRUB_KEYS = {
    "model": "example-model",
    "provider": "example-provider",
    "modelProvider": "example-provider",
    "api": "example-api-stream",
    "serverName": "example-mcp-server",
    "userAgent": "agentpane-fixture-probe/0.0.0 (example-os; x86_64)",
}


def collect_sensitive(obj, found: dict[str, str]) -> None:
    """Walk parsed JSON, recording exact string values sitting at SCRUB_KEYS."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in SCRUB_KEYS and isinstance(value, str) and value:
                found[value] = SCRUB_KEYS[key]
            collect_sensitive(value, found)
    elif isinstance(obj, list):
        for value in obj:
            collect_sensitive(value, found)


def scrub(raw: list[str]) -> tuple[list[str], dict[str, str]]:
    """Replace identifying values, preserving every other byte.

    We find the exact values by key (precise), then substitute them as quoted
    JSON strings in the raw text (so formatting stays byte-identical to what
    the agent actually emitted). Distinct real values collapsing onto one
    placeholder is fine -- nothing asserts on them.
    """
    found: dict[str, str] = {}
    for line in raw:
        try:
            collect_sensitive(json.loads(line), found)
        except ValueError:
            continue
    if not found:
        return raw, {}
    out = []
    for line in raw:
        for real, placeholder in found.items():
            line = line.replace(f'"{real}"', f'"{placeholder}"')
        out.append(line)
    return out, found


def make_workspace(files: dict[str, str]) -> Path:
    """A throwaway git repo. sbox and both agents want a real repo root."""
    work = Path(tempfile.mkdtemp(prefix="agentpane-fixture-"))
    subprocess.run(["git", "init", "-q"], cwd=work, check=True)
    for name, content in files.items():
        (work / name).write_text(content, encoding="utf-8")
    return work


def cli_version(cmd: str) -> str:
    try:
        out = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=30)
        return (out.stdout or out.stderr).strip().splitlines()[0]
    except Exception as exc:  # noqa: BLE001 - best-effort provenance only
        return f"<unknown: {exc}>"


class Recorder:
    """Reads a subprocess's stdout, records every line verbatim, dispatches events.

    Framing is LF-only *by construction*: we read bytes and split on b"\\n"
    only. Pi's docs call this out explicitly -- a reader that also splits on
    U+2028/U+2029 (Node's `readline`, and some text-mode readers) will corrupt
    JSON strings that legitimately contain those characters.
    """

    def __init__(self, proc: subprocess.Popen, on_event) -> None:
        self.proc = proc
        self.on_event = on_event
        self.raw: list[str] = []
        self.done = threading.Event()
        self._send_lock = threading.Lock()
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        buf = b""
        while True:
            chunk = self.proc.stdout.read1(65536) if hasattr(self.proc.stdout, "read1") else self.proc.stdout.read(1)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                self.raw.append(text)
                try:
                    event = json.loads(text)
                except ValueError:
                    continue  # recorded verbatim regardless; just not dispatchable
                try:
                    self.on_event(event)
                except Exception as exc:  # noqa: BLE001 - never kill the reader
                    print(f"  ! handler error: {exc}", file=sys.stderr)
        self.done.set()

    def send(self, obj: dict) -> None:
        with self._send_lock:
            self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
            self.proc.stdin.flush()

    def wait(self, timeout: float) -> bool:
        return self.done.wait(timeout)


PI_DIALOG_METHODS = ("select", "confirm", "input", "editor")


def capture_pi(scenario: str, spec: dict, timeout: float) -> dict:
    work = make_workspace(spec["files"])
    home = make_state_home(Path.home() / ".pi" / "agent", PI_STATE_FILES,
                           "agentpane-pihome-")
    dialogs: list[str] = []

    proc = subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-session"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd=work, env=dict(os.environ, PI_CODING_AGENT_DIR=str(home)),
    )

    def on_event(event: dict) -> None:
        kind = event.get("type", "")
        if kind in ("message_end", "tool_execution_end"):
            print(f"  << {kind}")
        elif kind == "extension_ui_request":
            method = event.get("method", "")
            if method in PI_DIALOG_METHODS:
                # Only dialog methods expect a reply; notify/setStatus/etc. do
                # not. Cancelling keeps the turn moving instead of deadlocking.
                dialogs.append(method)
                print(f"  >> extension dialog: {method} (cancelling)")
                rec.send({"type": "extension_ui_response",
                          "id": event.get("id"), "cancelled": True})
        # `agent_settled` is the real terminal signal: `agent_end` can still be
        # followed by a retry, compaction, or a queued continuation.
        if kind == "agent_settled":
            rec.done.set()

    rec = Recorder(proc, on_event)
    rec.send({"type": "prompt", "message": spec["prompt"]})
    settled = rec.wait(timeout)
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)

    return {
        "raw": rec.raw,
        "terminated_cleanly": settled,
        "census": Counter(
            json.loads(line).get("type", "<unparsed>")
            for line in rec.raw
            if line.startswith("{")
        ),
        "extra": {"dialogs_seen": dialogs},
    }


# Server-initiated requests we know how to answer. Approving keeps the turn
# moving; whether these fire at all is itself a finding (see DESIGN D2a).
CODEX_APPROVALS = {
    "item/commandExecution/requestApproval": {"decision": "accept"},
    "item/fileChange/requestApproval": {"decision": "accept"},
    "execCommandApproval": {"decision": "approved"},
    "applyPatchApproval": {"decision": "approved"},
}


def capture_codex(scenario: str, spec: dict, timeout: float) -> dict:
    work = make_workspace(spec["files"])
    home = make_state_home(Path.home() / ".codex", CODEX_STATE_FILES,
                           "agentpane-codexhome-")

    proc = subprocess.Popen(
        ["codex", "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd=work, env=dict(os.environ, CODEX_HOME=str(home)),
    )

    state = {"thread_id": None, "approvals": []}
    responses: dict[int, dict] = {}
    got_response = threading.Event()

    def on_event(event: dict) -> None:
        if "id" in event and "method" not in event:      # response to one of ours
            responses[event["id"]] = event
            got_response.set()
            return
        method = event.get("method", "")
        if "id" in event and method:                     # ServerRequest -- must answer
            state["approvals"].append(method)
            print(f"  >> server request: {method}")
            result = CODEX_APPROVALS.get(method)
            if result is not None:
                rec.send({"id": event["id"], "result": result})
            else:
                rec.send({"id": event["id"], "error": {"code": -32601,
                                                       "message": "probe does not handle this"}})
            return
        if method.startswith(("item/", "turn/")):
            if not method.endswith(("Delta", "delta", "textDelta", "outputDelta")):
                print(f"  << {method}")
        if method == "turn/completed" or method == "turn/failed":
            rec.done.set()

    rec = Recorder(proc, on_event)

    def request(req_id: int, method: str, params: dict, wait: float = 30.0) -> dict | None:
        got_response.clear()
        rec.send({"id": req_id, "method": method, "params": params})
        deadline = time.time() + wait
        while time.time() < deadline:
            if req_id in responses:
                return responses[req_id]
            got_response.wait(0.25)
            got_response.clear()
        return None

    request(1, "initialize", {"clientInfo": {"name": "agentpane-fixture-probe",
                                             "version": "0", "title": "agentpane"}})
    # `ephemeral` keeps the thread out of the on-disk rollout store entirely.
    started = request(2, "thread/start", {"ephemeral": True})
    if started and "result" in started:
        state["thread_id"] = started["result"].get("thread", {}).get("id")
    print(f"  thread: {state['thread_id']}")

    completed = False
    if state["thread_id"]:
        rec.send({"id": 3, "method": "turn/start",
                  "params": {"threadId": state["thread_id"],
                             "input": [{"type": "text", "text": spec["prompt"]}]}})
        completed = rec.wait(timeout)

    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(home, ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)

    return {
        "raw": rec.raw,
        "terminated_cleanly": completed,
        "census": Counter(
            json.loads(line).get("method", "<response>")
            for line in rec.raw
            if line.startswith("{")
        ),
        "extra": {"thread_id": state["thread_id"],
                  "server_requests_seen": state["approvals"]},
    }


BACKENDS = {"pi": (capture_pi, "pi"), "codex": (capture_codex, "codex")}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=sorted(BACKENDS), action="append",
                    help="repeatable; default is all")
    ap.add_argument("--scenario", choices=sorted(SCENARIOS), action="append",
                    help="repeatable; default is all")
    ap.add_argument("--timeout", type=float, default=120.0,
                    help="seconds to wait for a turn to settle (default: 120)")
    ap.add_argument("--no-scrub", action="store_true",
                    help="keep real model/provider/host identifiers (do not commit these)")
    args = ap.parse_args()

    backends = args.backend or sorted(BACKENDS)
    scenarios = args.scenario or list(SCENARIOS)
    failures = 0

    for backend in backends:
        capture, cmd = BACKENDS[backend]
        if shutil.which(cmd) is None:
            print(f"!! {cmd} not on PATH -- skipping {backend}", file=sys.stderr)
            failures += 1
            continue
        version = cli_version(cmd)
        outdir = FIXTURES / backend
        outdir.mkdir(parents=True, exist_ok=True)

        for scenario in scenarios:
            spec = SCENARIOS[scenario]
            print(f"\n=== {backend} / {scenario} ({version}) ===")
            started = time.time()
            result = capture(scenario, spec, args.timeout)
            elapsed = time.time() - started

            lines, scrubbed = (result["raw"], {}) if args.no_scrub else scrub(result["raw"])
            if scrubbed:
                print(f"  scrubbed {len(scrubbed)} identifying value(s): "
                      f"{', '.join(sorted(scrubbed.values()))}")

            jsonl = outdir / f"{scenario}.jsonl"
            jsonl.write_text("\n".join(lines) + "\n", encoding="utf-8")
            meta = {
                "backend": backend,
                "scenario": scenario,
                "covers": spec["covers"],
                "prompt": spec["prompt"],
                "workspace_files": sorted(spec["files"]),
                "cli_version": version,
                "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "elapsed_seconds": round(elapsed, 1),
                "lines": len(result["raw"]),
                "terminated_cleanly": result["terminated_cleanly"],
                "event_census": dict(sorted(result["census"].items())),
                **result["extra"],
            }
            (outdir / f"{scenario}.meta.json").write_text(
                json.dumps(meta, indent=2) + "\n", encoding="utf-8")

            status = "ok" if result["terminated_cleanly"] else "TIMED OUT"
            if not result["terminated_cleanly"]:
                failures += 1
            print(f"  -> {jsonl.relative_to(FIXTURES.parent.parent)} "
                  f"({len(result['raw'])} lines, {elapsed:.1f}s, {status})")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
