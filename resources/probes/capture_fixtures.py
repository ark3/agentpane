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
   an answer. We answer them and record that they happened. Codex's approval
   requests do fire: `tool-edit` caught one, and the OW-18 run has since
   established the conditions. An edit-provoking prompt raised an
   `item/fileChange/requestApproval` on a `read-only` thread under
   `on-request`. It raised none under `approvalPolicy: "never"`, and none on a
   `danger-full-access` thread under either policy.

We deliberately do *not* spawn through sbox here. sbox cannot fix (1) in a
nested sandbox, and the protocol is sbox-transparent over stdio (HANDOFF fact
8), so the captured bytes are identical either way. Production spawns through
sbox per D7; fixtures do not need to.

Neither backend's real session store is polluted: Pi runs with `--no-session`,
and Codex threads are started with `ephemeral: true`. A Codex scenario marked
`rollout` is the exception: its thread is not ephemeral, so Codex writes a
rollout -- under the throwaway CODEX_HOME, never under ~/.codex -- which is
copied out, scrubbed, and kept as `<scenario>.rollout.jsonl` beside the stream
(OW-zadupu). Its `.meta.json` adds `item_census` (the thread's own
`item/completed`s by item type), `rollout_census` (rollout lines by
`type/payload.type`, an `item_completed` also by its item's type), and
`models_seen`, the model each turn's `turn_context` named before the scrub.

Both backends are spawned with an explicit model, the one `AGENTS.md` pins,
because the flag is the whole of that constraint: Pi's default lives in a
mutable `settings.json` (and resolved no model at all on the day that file was
unreadable), Codex's in `config.toml`. Pi's can be overridden with `--pi-model`.
A Pi capture's `.meta.json` records the ref it passed (`model_flag`) beside the
models its assistant messages named (`models_seen`); a Codex capture's records
its `command`.
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

from fork_probe import codex_rollout_for, codex_rollout_lines, scrub_content

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
    "compact": {
        # A prompt that puts real content into the context, so a manual
        # compaction afterwards has something to summarise and the token
        # figure actually drops. The prose subject is irrelevant -- the
        # fixture is about the compaction wire shapes, not the answer.
        #
        # Several turns, not one: Pi refuses a manual compaction it judges too
        # small ("Nothing to compact (session too small)"), so the context has
        # to be primed past that floor before the compact command lands.
        "prompt": (
            "Explain, in several detailed paragraphs, how the TCP/IP networking "
            "stack works from the physical layer up through the application "
            "layer. Cover framing, addressing, routing, congestion control, and "
            "at least three application protocols."
        ),
        "prompts": [
            "Explain, in several detailed paragraphs, how the TCP/IP networking "
            "stack works from the physical layer up through the application "
            "layer. Cover framing, addressing, routing, congestion control, and "
            "at least three application protocols.",
            "Now do the same for how a modern optimizing compiler works: "
            "lexing, parsing, semantic analysis, IR, optimization passes, and "
            "code generation. Several detailed paragraphs.",
            "Now explain, in similar depth, how a log-structured merge-tree "
            "database engine handles writes, reads, compaction, and crash "
            "recovery. Several detailed paragraphs.",
            "Finally, explain in the same depth how a preemptive operating "
            "system kernel schedules threads, handles interrupts, and manages "
            "virtual memory. Several detailed paragraphs.",
        ],
        "files": {},
        "covers": "manual compaction: the compact command plus its events",
        # After the priming turns settle, issue the backend's manual-compaction
        # command and record the compaction request/response and events.
        "compact": True,
    },
    "subagent": {
        "prompt": (
            "Use the collaboration tool to spawn exactly one subagent. Ask it to reply "
            "with a short greeting, wait for it to finish, then reply with one short sentence."
        ),
        "files": {},
        "covers": "one parent turn spawning and waiting for a child-thread agent",
        "note": (
            "The parent and spawned child share one app-server connection. The child emits "
            "thread status, turn lifecycle, item lifecycle, agent-message delta, token-usage, "
            "and MCP-startup notifications alongside the parent's events. This capture did not "
            "emit thread/started for the child."
        ),
        "backends": ("codex",),
    },
    # The scenarios below keep the rollout Codex writes for the thread, beside
    # the stream, as `<scenario>.rollout.jsonl` (OW-zadupu): the stream drives
    # the live mapper and the rollout drives the preview, so one run feeds both
    # sides of `src/server/sessions/codex-conformance.test.ts`. Each runs at
    # the sandbox and approval policy `CodexAdapter` sends (`CODEX_THREAD`).
    "plan": {
        "prompt": "Propose a plan of at most three short steps for adding a --verbose flag to hello.py. "
                  "Do not run any commands, do not edit files, and do not ask me questions.",
        "files": {"hello.py": "print('hello')\n"},
        "covers": "a plan item, on a turn in collaboration mode `plan`",
        # Plan mode needs `initialize`'s experimental API and a `turn/start`
        # naming the mode (hydrate_window_probe.py); agentpane sends neither.
        "experimental": True,
        "turn": {"collaborationMode": {"mode": "plan", "settings": {
            "model": "gpt-5.6-luna", "reasoning_effort": None, "developer_instructions": None}}},
        "rollout": True,
        "backends": ("codex",),
    },
    "interrupt": {
        "prompt": "Write the numbers 1 through 400, one per line, with no prose.",
        "files": {},
        "covers": "a turn interrupted with `turn/interrupt` while its reply streams",
        # `turn/interrupt` goes out once this many `item/agentMessage/delta`s
        # of the thread's own have arrived, so the cut lands mid-reply.
        "interrupt_after_deltas": 40,
        "rollout": True,
        "backends": ("codex",),
    },
    "collab-failed": {
        "prompt": (
            "Use the collaboration tool's wait operation on the agent id "
            "019a0000-0000-7000-8000-000000000000, which does not exist. Do not spawn any agent. "
            "Then reply with one short sentence saying what happened."
        ),
        "files": {},
        "covers": "a collab tool call that fails",
        "rollout": True,
        "backends": ("codex",),
    },
    "collab-multi": {
        # A wait naming two children returned at the first to finish, and its
        # item named only that one (codex-cli 0.157.1), so the children are
        # given time to finish before the wait goes out.
        "prompt": (
            "Use the collaboration tool to spawn exactly two subagents, each asked to reply with a "
            "one-word greeting. Then run the shell command `sleep 15`. Then wait for both of them "
            "with a single wait call naming both, and reply with one short sentence."
        ),
        "files": {},
        "covers": "a collab call naming more than one child thread",
        "rollout": True,
        "backends": ("codex",),
    },
    "long-shell": {
        "prompt": "Run exactly this shell command, once, and then reply DONE:\n\n"
                  "for i in $(seq 1 45); do echo line-$i; sleep 1; done",
        "files": {},
        "covers": "a shell run that outlasts one exec yield, so it is polled to completion",
        "rollout": True,
        "backends": ("codex",),
    },
    "multi-patch": {
        "prompt": "Using a single apply_patch call, not a shell command, append a line saying 'goodbye' to "
                  "greeting.txt and create a new file notes.txt containing the line 'notes'. Then reply DONE.",
        "files": {"greeting.txt": "The quick brown fox jumps over the lazy dog.\n"},
        "covers": "one apply_patch touching more than one file",
        "rollout": True,
        "backends": ("codex",),
    },
    # Not provoked on codex-cli 0.157.1 with gpt-5.6-luna: the model found no
    # image_gen tool in its session (docs/MANUAL_TESTING.md, OW-zadupu), so no
    # fixture is committed for it. Kept so a later CLI can be tried.
    "image-gen": {
        "prompt": "Call your built-in image_gen tool directly to generate a small image of a plain red "
                  "circle on a white background. If image_gen is not among your tools, do not use any other "
                  "tool or fallback; reply with exactly UNAVAILABLE.",
        "files": {},
        "covers": "an image generation item",
        "rollout": True,
        "backends": ("codex",),
    },
    "compact-rollout": {
        # `compact` itself stays the codex-cli 0.147.0 capture: the OW-kelomi
        # test asserts its exact pre-compaction figure, and the token updates
        # between the compaction's start and completion that figure guards
        # against are that capture's. This one is a single turn, enough for
        # Codex to compact, kept with its rollout.
        "prompt": "Explain, in two short paragraphs, how TCP congestion control works.",
        "files": {},
        "covers": "manual compaction after one turn, with the rollout it leaves",
        "compact": True,
        "rollout": True,
        "backends": ("codex",),
    },
}


# Copied into the throwaway PI_CODING_AGENT_DIR. Credentials plus the model
# catalogue and trust state -- enough for a turn, without the AGENTS.md and
# scratch notes that live alongside them and would add noise to the fixture.
PI_STATE_FILES = ("auth.json", "models.json", "models-store.json",
                  "settings.json", "trust.json")
CODEX_STATE_FILES = ("auth.json", "config.toml")
CODEX_MODEL = "gpt-5.6-luna"
# What `CodexAdapter` sends on `thread/start`; a scenario that keeps its
# rollout runs at it, so nothing blocks on an approval and the run is the one
# agentpane would drive.
CODEX_THREAD = {"model": CODEX_MODEL, "sandbox": "danger-full-access", "approvalPolicy": "never"}
PI_PINNED_MODEL = "openrouter/deepseek/deepseek-v4.1-flash:high"


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
    # Rollout-only spellings (fork_probe.py's list), and the account a
    # rollout's `session_meta` names as its creator.
    "model_provider": "example-provider",
    "originator": "example-originator",
    "creator_user_id": "user-example",
    "creator_account_id": "example-account",
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


def scrub(raw: list[str], also: list[str] = ()) -> tuple[list[str], dict[str, str]]:
    """Replace identifying values and private account telemetry.

    We find the exact values by key (precise), then substitute them as quoted
    JSON strings in the raw text. Account rate-limit events retain their wire
    shape but not the operator's subscription, utilization, reset times, or
    credit state. Distinct real values collapsing onto one placeholder is fine
    -- nothing asserts on them. `also` contributes values to find without being
    scrubbed itself: the stream and its rollout name the same model, and each
    must lose it even where only the other names it by key.
    """
    found: dict[str, str] = {}
    for line in [*raw, *also]:
        try:
            collect_sensitive(json.loads(line), found)
        except ValueError:
            continue
    out = []
    for line in raw:
        for real, placeholder in found.items():
            line = line.replace(f'"{real}"', f'"{placeholder}"')
        try:
            event = json.loads(line)
            if event.get("method") == "account/rateLimits/updated":
                rate_limits = event["params"]["rateLimits"]
                event["params"]["rateLimits"] = {
                    key: value if key == "limitId" else None
                    for key, value in rate_limits.items()
                }
                line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
            elif event.get("method") == "account/updated" and "planType" in event["params"]:
                # The subscription, as the rate-limit events' `planType` is.
                event["params"]["planType"] = None
                line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        except (KeyError, TypeError, ValueError):
            pass
        out.append(line)
    return out, found


def scrub_rollout(raw: list[str], stream: list[str]) -> tuple[list[str], dict[str, str]]:
    """`scrub` for a rollout, plus what only a rollout carries.

    Its `event_msg` `token_count` records hold the account's `rate_limits`,
    the same telemetry `account/rateLimits/updated` carries on the wire, and
    are nulled the same way, `limit_id` aside. `scrub_content` blanks the host
    skills manifest Codex replays into the turn context (fork_probe.py).
    """
    lines, found = scrub(raw, stream)
    out = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            out.append(line)
            continue
        changed = scrub_content(record)
        payload = record.get("payload") if isinstance(record, dict) else None
        if (record.get("type") == "event_msg" and isinstance(payload, dict)
                and payload.get("type") == "token_count" and isinstance(payload.get("rate_limits"), dict)):
            payload["rate_limits"] = {key: value if key == "limit_id" else None
                                      for key, value in payload["rate_limits"].items()}
            changed = True
        out.append(json.dumps(record, separators=(",", ":"), ensure_ascii=False) if changed else line)
    return out, found


def rollout_census(lines: list[str]) -> dict[str, int]:
    """Rollout lines by `type/payload.type`, an `item_completed` also by its item's type."""
    census: Counter = Counter()
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            census["<unparsed>"] += 1
            continue
        payload = record.get("payload")
        kind = f"{record.get('type')}/{payload.get('type')}" if isinstance(payload, dict) and "type" in payload \
            else str(record.get("type"))
        if kind == "event_msg/item_completed":
            kind += f"/{(payload.get('item') or {}).get('type')}"
        census[kind] += 1
    return dict(sorted(census.items()))


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


def capture_pi(scenario: str, spec: dict, timeout: float, model: str) -> dict:
    work = make_workspace(spec["files"])
    home = make_state_home(Path.home() / ".pi" / "agent", PI_STATE_FILES,
                           "agentpane-pihome-")
    dialogs: list[str] = []
    # The compact scenario runs in two phases: the prompt turn, then a manual
    # compaction. `phase` decides which terminal signal sets `rec.done`.
    want_compact = bool(spec.get("compact"))
    phase = {"name": "prompt", "compacted": False}

    if want_compact:
        # Pi refuses to compact when everything still fits inside
        # `keepRecentTokens` (default 20000): with nothing older than that
        # window there is nothing to summarise, and it throws "Nothing to
        # compact (session too small)" (verified against 0.84.2's
        # `prepareCompaction`). Lower the window in the *throwaway* state dir so
        # the priming turns fall outside it and the manual compaction has real
        # history to fold. This edits only the copied settings, never the
        # operator's own.
        settings_path = home / "settings.json"
        try:
            settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        except ValueError:
            settings = {}
        compaction = dict(settings.get("compaction", {}))
        compaction["enabled"] = True
        compaction["keepRecentTokens"] = 2000
        settings["compaction"] = compaction
        settings_path.write_text(json.dumps(settings, indent=2), encoding="utf-8")

    proc = subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-session", "--model", model],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd=work, env=dict(os.environ, PI_CODING_AGENT_DIR=str(home)),
    )

    def on_event(event: dict) -> None:
        kind = event.get("type", "")
        if kind in ("message_end", "tool_execution_end", "compaction_start", "compaction_end"):
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
        # In the compact phase the terminal signal is `compaction_end`, not
        # `agent_settled`; the summary and its post-compaction token figure
        # ride that event and its response.
        if phase["name"] == "compact":
            if kind == "compaction_end":
                phase["compacted"] = True
                rec.done.set()
            return
        # `agent_settled` is the real terminal signal: `agent_end` can still be
        # followed by a retry, compaction, or a queued continuation.
        if kind == "agent_settled":
            rec.done.set()

    rec = Recorder(proc, on_event)
    prompts = spec.get("prompts") or [spec["prompt"]]
    settled = True
    for prompt in prompts:
        rec.done.clear()
        rec.send({"type": "prompt", "message": prompt})
        settled = rec.wait(timeout)
        if not settled:
            break
    if want_compact and settled:
        # Turns settled; now drive a manual compaction and record it.
        phase["name"] = "compact"
        rec.done.clear()
        print("  -- issuing manual compaction")
        rec.send({"type": "compact"})
        settled = rec.wait(timeout) and phase["compacted"]
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)

    # The model that answered, read off the assistant `message_end` events Pi
    # already sends -- no extra request, so the recorded stream is untouched.
    # `provider/model` is the spelling the flag uses, less its level suffix.
    # Read before the scrub, so it is the real value even when the fixture's is
    # a placeholder.
    models_seen: list[str] = []
    for line in rec.raw:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        message = event.get("message") if event.get("type") == "message_end" else None
        if isinstance(message, dict) and message.get("role") == "assistant":
            seen = f"{message.get('provider')}/{message.get('model')}"
            if seen not in models_seen:
                models_seen.append(seen)

    return {
        "raw": rec.raw,
        "terminated_cleanly": settled,
        "census": Counter(
            json.loads(line).get("type", "<unparsed>")
            for line in rec.raw
            if line.startswith("{")
        ),
        "extra": {"model_flag": model, "models_seen": models_seen,
                  "dialogs_seen": dialogs},
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
    want_compact = bool(spec.get("compact"))
    keep_rollout = bool(spec.get("rollout"))
    interrupt_at = spec.get("interrupt_after_deltas")

    proc = subprocess.Popen(
        ["codex", "-m", CODEX_MODEL, "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        cwd=work, env=dict(os.environ, CODEX_HOME=str(home)),
    )

    state = {"thread_id": None, "approvals": [], "turn_id": None, "deltas": 0,
             "interrupted_at": None}
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
        params = event.get("params", {})
        if params.get("threadId") == state["thread_id"]:
            if method == "turn/started":
                state["turn_id"] = params.get("turn", {}).get("id")
            elif method == "item/agentMessage/delta":
                state["deltas"] += 1
                if interrupt_at and state["deltas"] >= interrupt_at and state["interrupted_at"] is None:
                    state["interrupted_at"] = state["deltas"]
                    print(f"  -- turn/interrupt at {state['deltas']} deltas")
                    rec.send({"id": 900, "method": "turn/interrupt",
                              "params": {"threadId": state["thread_id"], "turnId": state["turn_id"]}})
        if (method == "turn/completed" or method == "turn/failed") and (
            event.get("params", {}).get("threadId") == state["thread_id"]
        ):
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
                                             "version": "0", "title": "agentpane"},
                              **({"capabilities": {"experimentalApi": True}}
                                 if spec.get("experimental") else {})})
    # `ephemeral` keeps the thread out of the on-disk rollout store entirely;
    # a scenario that keeps its rollout writes one under the throwaway
    # CODEX_HOME, never under ~/.codex.
    started = request(2, "thread/start", CODEX_THREAD if keep_rollout else {"ephemeral": True})
    if started and "result" in started:
        state["thread_id"] = started["result"].get("thread", {}).get("id")
    print(f"  thread: {state['thread_id']}")

    completed = False
    if state["thread_id"]:
        prompts = spec.get("prompts") or [spec["prompt"]]
        turn_id = 3
        for prompt in prompts:
            rec.done.clear()
            rec.send({"id": turn_id, "method": "turn/start",
                      "params": {"threadId": state["thread_id"],
                                 "input": [{"type": "text", "text": prompt}],
                                 **({"model": CODEX_MODEL} if keep_rollout else {}),
                                 **spec.get("turn", {})}})
            turn_id += 1
            completed = rec.wait(timeout)
            if not completed:
                break
        if want_compact and completed:
            # Manual compaction runs as its own (non-steerable) turn: send
            # `thread/compact/start` and wait for that turn to complete, so the
            # recorded stream carries the contextCompaction item and the
            # post-compaction token usage.
            rec.done.clear()
            print("  -- issuing thread/compact/start")
            rec.send({"id": turn_id, "method": "thread/compact/start",
                      "params": {"threadId": state["thread_id"]}})
            completed = rec.wait(timeout)

    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()

    # Read the rollout after the process has exited, so it is complete, and
    # before the throwaway home goes. A spawned child writes a rollout of its
    # own; only the parent's is kept, the others are counted.
    rollout: list[str] | None = None
    extra: dict = {}
    if keep_rollout:
        path = codex_rollout_for(home, state["thread_id"]) if state["thread_id"] else None
        if path is None:
            # Never an empty `.rollout.jsonl` written as though it were the run's.
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(work, ignore_errors=True)
            raise RuntimeError(f"{scenario}: no rollout found for thread {state['thread_id']}")
        rollout = [line.decode("utf-8") for line in codex_rollout_lines(path)]
        all_rollouts = list((home / "sessions").rglob("*.jsonl")) if (home / "sessions").exists() else []
        models_seen: list[str] = []
        for line in rollout:
            record = json.loads(line)
            if record.get("type") == "turn_context":
                model = record.get("payload", {}).get("model")
                if model not in models_seen:
                    models_seen.append(model)
        # The model each turn ran on, read off the unscrubbed `turn_context`.
        extra = {"models_seen": models_seen, "child_rollouts": len(all_rollouts) - 1,
                 "rollout_census": rollout_census(rollout)}
    shutil.rmtree(home, ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)

    # Completed items on the thread's own stream, by type; a child's apart.
    items: Counter = Counter()
    child_items: Counter = Counter()
    for line in rec.raw:
        event = json.loads(line) if line.startswith("{") else {}
        if event.get("method") == "item/completed":
            params = event["params"]
            (items if params.get("threadId") == state["thread_id"] else child_items)[params["item"]["type"]] += 1

    return {
        "raw": rec.raw,
        "rollout": rollout,
        "terminated_cleanly": completed,
        "census": Counter(
            json.loads(line).get("method", "<response>")
            for line in rec.raw
            if line.startswith("{")
        ),
        "extra": {"thread_id": state["thread_id"],
                  "command": f"codex -m {CODEX_MODEL} app-server",
                  "server_requests_seen": state["approvals"],
                  "item_census": dict(sorted(items.items())),
                  **({"child_item_census": dict(sorted(child_items.items()))} if child_items else {}),
                  **({"interrupted_at_deltas": state["interrupted_at"]} if interrupt_at else {}),
                  **extra},
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
    ap.add_argument("--pi-model", default=PI_PINNED_MODEL,
                    help="model ref passed to Pi's --model (default: the model AGENTS.md pins)")
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
            if backend not in spec.get("backends", backends):
                continue
            print(f"\n=== {backend} / {scenario} ({version}) ===")
            started = time.time()
            kwargs = {"model": args.pi_model} if backend == "pi" else {}
            result = capture(scenario, spec, args.timeout, **kwargs)
            elapsed = time.time() - started

            rollout = result.get("rollout")
            lines, scrubbed = (result["raw"], {}) if args.no_scrub else scrub(result["raw"], rollout or [])
            if scrubbed:
                print(f"  scrubbed {len(scrubbed)} identifying value(s): "
                      f"{', '.join(sorted(scrubbed.values()))}")

            jsonl = outdir / f"{scenario}.jsonl"
            jsonl.write_text("\n".join(lines) + "\n", encoding="utf-8")
            if rollout is not None:
                kept = rollout if args.no_scrub else scrub_rollout(rollout, result["raw"])[0]
                # `.rollout.jsonl` keeps it under the scrub guard, which reads every `.jsonl`.
                (outdir / f"{scenario}.rollout.jsonl").write_text("\n".join(kept) + "\n", encoding="utf-8")
                print(f"  rollout: {len(kept)} lines, census {result['extra']['rollout_census']}")
            if "item_census" in result["extra"]:
                print(f"  items: {result['extra']['item_census']}")
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
                **({"note": spec["note"]} if "note" in spec else {}),
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
