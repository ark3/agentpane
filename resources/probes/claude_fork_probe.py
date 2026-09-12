#!/usr/bin/env python3
"""Claude Code mid-stream fork probe -- what a fork costs the PARENT turn.

`docs/DESIGN.md` D15 ("agentpane stops a streaming turn before forking it, on
every backend") reasons about Pi and Codex only; Claude Code is not mentioned
in it once, yet the abort is client-side and backend-agnostic
(`src/client/controller.ts` `forkAndSubmit`) so it applies there too. Nothing
had ever measured what it costs on Claude. This probe answers the two
questions OW-japuzo names, and reads the PARENT in both cells -- never the
fork.

  claude_kill_mid_stream  -> Is the parent's partial reply already on disk when
                             the adapter kills it? `claude/adapter.ts` `fork()`
                             goes through `replaceProcess`, whose first acts are
                             `previous.live = false` and `await
                             previous.proc.kill()`, so today's fork terminates
                             the process hosting the in-flight turn. This cell
                             reproduces that kill -- SIGTERM, grace, SIGKILL,
                             matching `ChildClaudeProcess.kill()` -- and hashes
                             the parent's store file at three points: after the
                             priming turn, immediately before the kill, and
                             after the child is gone. If Claude Code flushes
                             assistant text as it streams, today's abort loses
                             less than it looks like it does.

  claude_fork_beside      -> Can the parent turn survive at all? Spawns the
                             fork as a SECOND child (`--resume <id>
                             --resume-session-at <uuid> --fork-session`)
                             instead of replacing the first, leaves the parent
                             running, and records whether its deltas keep
                             arriving, whether `result` lands, and whether the
                             full reply reaches the parent's store. This is a
                             probe, NOT a proposal: it establishes the
                             behaviour before anyone decides whether
                             `adapter.ts` should work this way. Nothing here
                             touches the adapter.

Discipline taken from the `codex_fork_mid_stream` cell in `fork_probe.py`, and
it is the load-bearing part: sleeping cannot distinguish a surviving parent
from an action that landed after the turn had already finished, and that
failure mode is silent. Both cells wait for a POSITIVE streaming signal on the
parent -- a `stream_event`/`message_start` plus `MIN_DELTAS` accumulating
`content_block_delta` text deltas, and no `result` yet -- and record
`result: "unearned"` with a non-zero process exit if it is missing.

Two things here are additions rather than inheritance, and both close gaps the
Codex cell has too. `still_streaming` re-checks at the instant of the action,
where `codex_fork_mid_stream` acts straight off `await_streaming`'s return and
gates only on `streaming_confirmed`. And the "unearned" gate covers the DISK
read as well as the wire: a store file the cell could not resolve, a baseline
that does not exist, or a store whose existing lines changed under it all fail
the cell, because the headline finding here is an ABSENCE on disk and an
absence is exactly what a file that was never found also produces.

Why this is a separate file and not a third `--backend` in `fork_probe.py`:
that probe's two session classes are JSON-RPC request/response clients over a
long-lived server, and "fork" there is one RPC on that server. Claude Code has
no RPC surface for a fork at all -- a fork is a process spawn with
`--fork-session` -- and its wire is an unmatched NDJSON event stream with no
request ids. Sharing the file would have meant a third session class with
nothing in common with the other two.

Spawn note (differs from production, deliberately): production's command line
is `direnv exec <cwd> sbox -- claude -p ...`
(`claude/process.ts` `buildClaudeSpawnCommand`), but `direnv` is not on PATH on
the home server, so this probe spawns `claude` directly and passes by hand the
`--permission-mode bypassPermissions` that sbox would have injected. The same
substitution was used for every earlier Claude capture
(`resources/fixtures/claude/*.meta.json`). What sbox changes is filesystem
reach; nothing measured here -- store flush timing, process lifetime, delta
arrival -- goes through it, and the prompts drive no tools.

The model is pinned, always and explicitly: `--model haiku`.

Usage:
    python3 claude_fork_probe.py
    python3 claude_fork_probe.py --timeout 120 --cell kill --cell fork

Needs `claude` on PATH with working credentials, a writable `~/.claude`, and a
writable temp area. Costs tokens: each cell drives two real turns.

Framing note: Claude Code's NDJSON is LF-framed and read as bytes-to-text
line by line here; the probe's own prompts never embed U+2028/U+2029.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

CLAUDE_ROOT = Path.home() / ".claude" / "projects"

# Long enough to still be streaming when the cell acts on it, short enough to
# finish inside the timeout. The Codex mid-stream cell asks for the same range.
LONG_PROMPT = "Count from 1 to 400. Print one number per line and nothing else."
PRIME_PROMPT = "Say exactly: ALPHA"
FORK_PROMPT = "Say exactly: BETA"

# The deltas the cell waits for must be the ANSWER streaming, not the coda. The
# first run of this probe (2.1.268, haiku) answered the counting prompt by
# calling Bash, and the six text deltas it then saw were an 88-character
# "the counting is complete" summary -- so the action landed at the very end of
# the turn, and `result` was already in the buffer when the cell read back.
# `--tools ""` removes the shortcut (there is nothing to measure about a tool
# call here), and the threshold is raised well past a one-paragraph coda.
MIN_DELTAS = 40

# Sample marks across the parent's reply, in accumulated text deltas. One
# sample cannot tell "the store never gains assistant text mid-turn" from "it
# had not gained any yet at the one point we looked", and the first version of
# this cell had exactly one. The kill lands at the last mark. The ceiling is
# set below the ~200 deltas the 1-to-400 reply runs to, and a turn that settles
# before the last mark is reported unearned rather than quietly sampled short.
SAMPLE_MARKS = (40, 80, 120, 160)

# Pinned, and not a flag: AGENTS.md "Evidence" binds agent-driven work on the
# home server to Haiku, `fork_probe.py` exposes no model flag either, and a
# knob whose help text says not to turn it is not configurability.
MODEL = "haiku"

# Matches ChildClaudeProcess.kill() in claude/process.ts.
TERMINATE_GRACE_S = 2.0
KILL_GRACE_S = 1.0


def preview(text, limit=120):
    if text is None:
        return None
    text = text.replace("\n", "\\n")
    return text if len(text) <= limit else text[:limit] + f"...[{len(text)} chars]"


# ---------------------------------------------------------------------------
# The child
# ---------------------------------------------------------------------------


class ClaudeChild:
    """One `claude -p` process, its stdout drained into `self.events`.

    Events are appended with a monotonic offset so a cell can say when a
    signal arrived relative to its own actions, and `mark()` snapshots the
    length so `events_since` reads only what followed an action.
    """

    def __init__(self, cwd, session_id=None, resume=None, fork_at=None):
        self.args = [
            "claude",
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            # sbox would inject this; see the module doc.
            "--permission-mode", "bypassPermissions",
            # No tools: see MIN_DELTAS. The prompt must be answered by
            # generating text, because text streaming is the whole subject.
            "--tools", "",
            "--model", MODEL,
        ]
        if resume:
            self.args += ["--resume", resume]
        if fork_at:
            self.args += ["--resume-session-at", fork_at, "--fork-session"]
        if session_id:
            self.args += ["--session-id", session_id]

        self.started_at = time.monotonic()
        self.events = []
        self.stderr_tail = ""
        self.lock = threading.Lock()
        self.proc = subprocess.Popen(
            self.args, cwd=str(cwd), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    @property
    def command_line(self):
        return " ".join(self.args)

    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self.lock:
                self.events.append((round((time.monotonic() - self.started_at) * 1000), event))

    def _read_stderr(self):
        for line in self.proc.stderr:
            self.stderr_tail = (self.stderr_tail + line)[-4096:]

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def mark(self):
        with self.lock:
            return len(self.events)

    def events_since(self, mark):
        with self.lock:
            return list(self.events[mark:])

    def write_user(self, text):
        line = json.dumps({"type": "user",
                           "message": {"role": "user",
                                       "content": [{"type": "text", "text": text}]}})
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def await_event(self, mark, predicate, timeout):
        """First event at or after `mark` satisfying `predicate`, or None."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for offset, event in self.events_since(mark):
                if predicate(event):
                    return offset, event
            if self.proc.poll() is not None:
                # Drain whatever the reader thread still had queued.
                time.sleep(0.2)
                for offset, event in self.events_since(mark):
                    if predicate(event):
                        return offset, event
                return None
            time.sleep(0.05)
        return None

    def kill_like_adapter(self):
        """SIGTERM, then SIGKILL after the grace window -- process.ts kill()."""
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.wait(timeout=TERMINATE_GRACE_S)
            return {"escalated_to_sigkill": False, "exit_code": self.proc.returncode}
        except subprocess.TimeoutExpired:
            pass
        self.proc.kill()
        try:
            self.proc.wait(timeout=KILL_GRACE_S)
        except subprocess.TimeoutExpired:
            pass
        return {"escalated_to_sigkill": True, "exit_code": self.proc.returncode}

    def close(self):
        if self.proc.poll() is None:
            self.kill_like_adapter()


# ---------------------------------------------------------------------------
# Event predicates -- the stream-json names are in claude/protocol.ts
# ---------------------------------------------------------------------------


def is_init(event):
    return event.get("type") == "system" and event.get("subtype") == "init"


def is_result(event):
    return event.get("type") == "result"


def is_message_start(event):
    return (event.get("type") == "stream_event"
            and (event.get("event") or {}).get("type") == "message_start")


def text_delta(event):
    if event.get("type") != "stream_event":
        return None
    body = event.get("event") or {}
    if body.get("type") != "content_block_delta":
        return None
    delta = body.get("delta") or {}
    return delta.get("text")


def assistant_text(event):
    if event.get("type") != "assistant":
        return None
    content = (event.get("message") or {}).get("content")
    if not isinstance(content, list):
        return None
    return "".join(b.get("text", "") for b in content
                   if isinstance(b, dict) and b.get("type") == "text")


def still_streaming(child, mark):
    """Re-read the buffer at the instant of the action.

    `await_streaming` returns the moment its threshold is met, and the turn can
    settle in the gap between that return and the action -- which is how the
    first run of this probe killed a turn that had already finished. This is
    the check the cell records beside the action itself.

    NOT inherited from `fork_probe.py`: `codex_fork_mid_stream` fires
    `thread/fork` straight off `await_streaming`'s return and gates only on
    `streaming_confirmed`. This is an addition, and the gap it closes is real
    on both probes.
    """
    return not any(is_result(e) for _, e in child.events_since(mark))


def await_delta_count(child, mark, target, timeout):
    """Wait until `target` text deltas have accumulated since `mark`.

    Returns the count actually reached and whether the turn settled first; a
    settle is not an error here, it is the thing the caller has to report,
    because a sample taken after the turn ended measures nothing.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = [e for _, e in child.events_since(mark)]
        deltas = [t for t in (text_delta(e) for e in events) if t]
        settled = any(is_result(e) for e in events)
        if settled or len(deltas) >= target:
            return {"deltas": len(deltas), "chars": len("".join(deltas)), "settled": settled}
        if child.proc.poll() is not None:
            break
        time.sleep(0.05)
    events = [e for _, e in child.events_since(mark)]
    deltas = [t for t in (text_delta(e) for e in events) if t]
    return {"deltas": len(deltas), "chars": len("".join(deltas)),
            "settled": any(is_result(e) for e in events), "timed_out": True}


def await_streaming(child, mark, min_deltas, timeout):
    """Positive proof the parent turn is in flight, or a refusal to report.

    Mirrors `fork_probe.py`'s Codex cell: a turn-start signal
    (`message_start`) plus `min_deltas` accumulating text deltas, and NO
    `result` yet. Without all three, nothing the cell goes on to observe about
    the parent was earned.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        events = [e for _, e in child.events_since(mark)]
        started = any(is_message_start(e) for e in events)
        deltas = [t for t in (text_delta(e) for e in events) if t]
        settled = any(is_result(e) for e in events)
        if settled or (started and len(deltas) >= min_deltas):
            return {
                "streaming_confirmed": bool(started and len(deltas) >= min_deltas and not settled),
                "message_start_seen": started,
                "deltas_before_action": len(deltas),
                "streamed_text_before_action": "".join(deltas),
                "settled_before_action": settled,
            }
        if child.proc.poll() is not None:
            break
        time.sleep(0.05)
    events = [e for _, e in child.events_since(mark)]
    deltas = [t for t in (text_delta(e) for e in events) if t]
    return {
        "streaming_confirmed": False,
        "message_start_seen": any(is_message_start(e) for e in events),
        "deltas_before_action": len(deltas),
        "streamed_text_before_action": "".join(deltas),
        "settled_before_action": any(is_result(e) for e in events),
    }


# ---------------------------------------------------------------------------
# The store on disk -- ~/.claude/projects/<munged-cwd>/<session-id>.jsonl
# ---------------------------------------------------------------------------


def store_file(session_id):
    """Located by filename match, the way the adapter's default reader does:
    the directory munging is lossy, so the id is the only reliable key."""
    hits = sorted(CLAUDE_ROOT.glob(f"*/{session_id}.jsonl"))
    return hits[0] if hits else None


def store_snapshot(path):
    if path is None or not path.exists():
        return {"exists": False, "sha256": None, "lines": 0, "bytes": 0, "raw": []}
    data = path.read_bytes()
    raw = [l for l in data.decode("utf-8", "replace").splitlines() if l.strip()]
    return {"exists": True, "sha256": hashlib.sha256(data).hexdigest(),
            "lines": len(raw), "bytes": len(data), "raw": raw}


def line_kind(line):
    """A census key for one store line: its `type`, plus enough to tell an
    assistant text line from a tool line without quoting model wording."""
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        return "unparseable"
    kind = rec.get("type", "?")
    if kind in ("assistant", "user"):
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, list):
            blocks = sorted({b.get("type", "?") for b in content if isinstance(b, dict)})
            return f"{kind}:{'+'.join(blocks) or 'empty'}"
        if isinstance(content, str):
            return f"{kind}:string"
    return kind


def store_assistant_text(line):
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        return None
    if rec.get("type") != "assistant":
        return None
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return None
    text = "".join(b.get("text", "") for b in content
                   if isinstance(b, dict) and b.get("type") == "text")
    return text or None


def gained(before_raw, after_raw):
    """Census of the lines the store gained, and any assistant text among them.

    Recorded per run because the probe deletes its workspace: this census is
    all a later reader gets, and it is how a store-shape change shows up as a
    change rather than as an unexplained count.
    """
    new = after_raw[len(before_raw):] if len(after_raw) >= len(before_raw) else []
    census = {}
    texts = []
    for line in new:
        census[line_kind(line)] = census.get(line_kind(line), 0) + 1
        text = store_assistant_text(line)
        if text:
            texts.append({"chars": len(text),
                          "head": text[:60].replace("\n", "\\n"),
                          "tail": text[-40:].replace("\n", "\\n")})
    return {"count": len(new), "census": census, "assistant_text": texts,
            "prefix_preserved": after_raw[:len(before_raw)] == before_raw}


def last_entry_uuid(raw):
    """The fork point: the last store line carrying a `uuid`."""
    for line in reversed(raw):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("uuid"):
            return rec["uuid"]
    return None


# ---------------------------------------------------------------------------
# Shared setup
# ---------------------------------------------------------------------------


def make_workspace(prefix):
    """A throwaway git repo under the temp area, so the probe's sessions land
    in their own `~/.claude/projects/` directory and never in this repo's."""
    path = Path(tempfile.mkdtemp(prefix=prefix))
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    return path


def start_primed_parent(work, timeout):
    """A parent child with one settled turn behind it, so there is a store file
    with a forkable entry before anything streams.

    The prime prompt is written BEFORE `system:init` is awaited, and that order
    is not incidental: on 2.1.268 a `claude -p` child with stream-json input
    emits nothing at all until it has been given a message, so awaiting init
    first burns the whole timeout and then reports `init` missing.
    """
    session_id = str(uuid.uuid4())
    child = ClaudeChild(work, session_id=session_id)
    child.write_user(PRIME_PROMPT)
    init = child.await_event(0, is_init, timeout)
    primed = child.await_event(0, is_result, timeout)
    return child, session_id, init, primed


def quiesce_store(path, settle_s=3.0, timeout=30.0):
    """Wait for the store file to stop changing, and return the snapshot.

    The store lags the stream: the priming turn's own lines were still landing
    after its `result` on the first run, and they turned up in the census of
    what the file gained "while streaming", which is exactly the measurement
    they would corrupt. The baseline is taken only once the file has held the
    same hash for `settle_s`.
    """
    deadline = time.monotonic() + timeout
    last = store_snapshot(path)
    stable_since = time.monotonic()
    while time.monotonic() < deadline:
        time.sleep(0.25)
        now = store_snapshot(path)
        if now["sha256"] != last["sha256"]:
            last = now
            stable_since = time.monotonic()
        elif time.monotonic() - stable_since >= settle_s:
            return now
    return store_snapshot(path)


def claude_version():
    out = subprocess.run(["claude", "--version"], capture_output=True, text=True)
    return out.stdout.strip() or out.stderr.strip()


# ---------------------------------------------------------------------------
# Cell 1: the kill the adapter performs today
# ---------------------------------------------------------------------------


def cell_kill_mid_stream(timeout):
    work = make_workspace("agentpane-claudefork-kill-")
    child = None
    try:
        child, session_id, init, primed = start_primed_parent(work, timeout)
        path = store_file(session_id)
        baseline = quiesce_store(path)

        mark = child.mark()
        child.write_user(LONG_PROMPT)
        streaming = await_streaming(child, mark, min_deltas=MIN_DELTAS, timeout=timeout)

        # Walk the reply, reading the store at each mark. Each sample is taken
        # as close to its delta count as a separate disk read can get, and any
        # error in that residual window credits the file with MORE streamed
        # text than it had rather than less -- the direction that cannot
        # manufacture an absence.
        samples = []
        previous = baseline
        for target in SAMPLE_MARKS:
            reached = await_delta_count(child, mark, target, timeout)
            snap = store_snapshot(path)
            samples.append({
                "target_deltas": target,
                "deltas_at_sample": reached["deltas"],
                "streamed_chars_at_sample": reached["chars"],
                "turn_had_settled": reached["settled"],
                "sha256": snap["sha256"],
                "lines": snap["lines"],
                "gained_since_previous_sample": gained(previous["raw"], snap["raw"]),
            })
            previous = snap
        at_kill = previous

        streaming_at_kill = still_streaming(child, mark)
        killed = child.kill_like_adapter()
        # Both reads: the immediate one answers "was anything flushed by the
        # time the process was gone", the quiesced one answers "did anything
        # arrive later". A single sample here cannot separate them.
        after_kill_immediate = store_snapshot(path)
        after_kill = quiesce_store(path)

        events = [e for _, e in child.events_since(mark)]
        gained_by_kill = gained(at_kill["raw"], after_kill["raw"])
        # The headline here is an ABSENCE on disk, and a store file that was
        # never resolved produces the identical absence -- so the disk read is
        # gated exactly as hard as the wire signals are. `prefix_preserved`
        # gates too: the census only means anything if the file is append-only,
        # and if it ever stops being, every "gained" number above is wrong.
        disk_earned = (
            path is not None
            and baseline["exists"]
            and all(s["gained_since_previous_sample"]["prefix_preserved"] for s in samples)
            and gained_by_kill["prefix_preserved"]
        )
        # A sample taken after the turn ended measures nothing, and the kill
        # must land inside the turn.
        marks_earned = not any(s["turn_had_settled"] for s in samples)
        return {
            "operation": "the parent process is killed mid-turn, the way "
                         "claude/adapter.ts fork() -> replaceProcess() kills it",
            "reads": "the PARENT session only",
            "command_line": child.command_line,
            "parent_session_id": session_id,
            "init_session_id": (init[1].get("session_id") if init else None),
            "init_model": (init[1].get("model") if init else None),
            "init_permission_mode": (init[1].get("permissionMode") if init else None),
            "primed_turn_ok": primed is not None,
            "streaming_confirmed_before_kill": streaming["streaming_confirmed"],
            "message_start_seen": streaming["message_start_seen"],
            # Named for WHERE they were taken. These are the first sample's
            # numbers, at the moment `await_streaming` crossed its threshold,
            # and the kill is now four marks later -- calling them
            # "before_kill" invited reading them as the state at the kill,
            # which they never were. The count is the first poll past
            # MIN_DELTAS, not a chosen value.
            "deltas_at_first_mark": streaming["deltas_before_action"],
            "streamed_chars_at_first_mark": len(streaming["streamed_text_before_action"]),
            "streamed_text_preview_at_first_mark": preview(streaming["streamed_text_before_action"]),
            "parent_turn_settled_at_first_mark": streaming["settled_before_action"],
            "still_streaming_at_the_kill_itself": streaming_at_kill,
            "kill": killed,
            "store_file": path.name if path else None,
            "store_dir": path.parent.name if path else None,
            # The question: did the streaming partial reach disk before we killed?
            "store_sha256_after_prime": baseline["sha256"],
            "store_sha256_at_kill": at_kill["sha256"],
            "store_sha256_after_kill": after_kill["sha256"],
            "store_lines_after_prime": baseline["lines"],
            "store_lines_at_kill": at_kill["lines"],
            "store_lines_after_kill": after_kill["lines"],
            "store_changed_while_streaming": baseline["sha256"] != at_kill["sha256"],
            "store_changed_by_the_kill": at_kill["sha256"] != after_kill["sha256"],
            "store_changed_before_quiescing_after_kill":
                at_kill["sha256"] != after_kill_immediate["sha256"],
            "store_lines_after_kill_immediate": after_kill_immediate["lines"],
            # Per mark across the whole reply, not one point in it.
            "samples_across_the_turn": samples,
            "gained_while_streaming": gained(baseline["raw"], at_kill["raw"]),
            "gained_by_the_kill": gained_by_kill,
            "store_resolved": path is not None,
            "baseline_store_exists": baseline["exists"],
            "disk_read_earned": disk_earned,
            "all_samples_mid_turn": marks_earned,
            "assistant_events_during_turn": [preview(t) for t in
                                             (assistant_text(e) for e in events) if t],
            "result_events_during_turn": [e.get("subtype") for e in events if is_result(e)],
            "stderr_tail": child.stderr_tail.strip()[-400:] or None,
            "result": ("measured" if (streaming["streaming_confirmed"] and streaming_at_kill
                                      and disk_earned and marks_earned) else "unearned"),
        }
    finally:
        if child:
            child.close()
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------------------
# Cell 2: the fork spawned BESIDE the parent instead of replacing it
# ---------------------------------------------------------------------------


def cell_fork_beside(timeout):
    work = make_workspace("agentpane-claudefork-beside-")
    child = None
    fork_child = None
    try:
        child, session_id, init, primed = start_primed_parent(work, timeout)
        path = store_file(session_id)
        baseline = quiesce_store(path)
        fork_point = last_entry_uuid(baseline["raw"])

        mark = child.mark()
        child.write_user(LONG_PROMPT)
        streaming = await_streaming(child, mark, min_deltas=MIN_DELTAS, timeout=timeout)

        at_fork = store_snapshot(path)
        streaming_at_fork = still_streaming(child, mark)
        fork_session_id = str(uuid.uuid4())
        fork_started_at = time.monotonic()
        fork_child = ClaudeChild(work, session_id=fork_session_id, resume=session_id,
                                 fork_at=fork_point)
        # Taken at the spawn and NOT after any await on the fork: everything
        # counted against the parent below is counted from this mark, so an
        # await placed above it would silently credit the parent's post-fork
        # streaming to before the fork. The first run of this cell made exactly
        # that mistake by waiting for the fork's `system:init` here -- which a
        # `claude -p` child does not emit until it is given a message, so the
        # mark moved by a whole timeout.
        fork_mark = child.mark()

        # The parent is the subject; the fork gets the cheapest check that is
        # still real. One short prompt is that check: a spawned process proves
        # nothing (`fork_probe.py` README: "a returned id alone cannot pass the
        # check"), and the fork emits no `system:init` at all until it is asked
        # something. It also makes the concurrency claim honest -- two children
        # with turns in flight at once, rather than one running and one idle.
        fork_child.write_user(FORK_PROMPT)
        fork_init = fork_child.await_event(0, is_init, timeout)
        fork_settled = fork_child.await_event(0, is_result, timeout)
        fork_reply = next((t for t in (assistant_text(e) for _, e in fork_child.snapshot()) if t),
                          None)

        settle = child.await_event(fork_mark, is_result, timeout)
        deltas_after_fork = len([t for t in
                                 (text_delta(e) for _, e in child.events_since(fork_mark)) if t])
        # BOTH reads, in one run. The immediate one is taken as soon as the
        # parent's `result` is seen; the quiesced one waits for the writer.
        # Taking only the second cannot say when the reply landed, and taking
        # only the first says the reply never landed at all -- which is what
        # the first version of this cell reported, across two runs it could not
        # compare. The pair makes "the store lags `result`" a within-run
        # measurement rather than an inference over separate sessions.
        after_at_result = store_snapshot(path)
        after = quiesce_store(path)
        fork_path = store_file(fork_session_id)
        parent_gained = gained(at_fork["raw"], after["raw"])
        fork_disk_earned = (path is not None and baseline["exists"]
                            and parent_gained["prefix_preserved"])

        return {
            "operation": "a SECOND claude child spawned with --resume "
                         "--resume-session-at --fork-session while the parent "
                         "child keeps running its turn",
            "reads": "the PARENT session; the fork gets existence checks only",
            "not_a_proposal": "the adapter is unchanged; this measures whether "
                              "the behaviour is available at all",
            "parent_command_line": child.command_line,
            "fork_command_line": fork_child.command_line,
            "parent_session_id": session_id,
            "init_model": (init[1].get("model") if init else None),
            "primed_turn_ok": primed is not None,
            "fork_point_entry_uuid": fork_point,
            "streaming_confirmed_before_fork": streaming["streaming_confirmed"],
            "message_start_seen": streaming["message_start_seen"],
            # First poll past MIN_DELTAS, and the fork fires immediately after.
            "deltas_before_fork": streaming["deltas_before_action"],
            "parent_turn_settled_before_fork": streaming["settled_before_action"],
            "still_streaming_at_the_fork_itself": streaming_at_fork,
            # The fork child.
            "fork_session_id": fork_session_id,
            "fork_init_seen": fork_init is not None,
            "fork_init_ms": (round((time.monotonic() - fork_started_at) * 1000)
                             if fork_init else None),
            "fork_init_session_id": (fork_init[1].get("session_id") if fork_init else None),
            "fork_adopted_given_session_id": (
                bool(fork_init) and fork_init[1].get("session_id") == fork_session_id),
            "fork_drove_a_turn": fork_settled is not None,
            "fork_result_subtype": (fork_settled[1].get("subtype") if fork_settled else None),
            "fork_reply": preview(fork_reply),
            "fork_store_on_disk": fork_path is not None,
            "fork_store_lines": store_snapshot(fork_path)["lines"] if fork_path else 0,
            "fork_stderr_tail": fork_child.stderr_tail.strip()[-400:] or None,
            # What the parent did with a second child alive beside it.
            "parent_still_running_after_fork": child.proc.poll() is None,
            "parent_deltas_after_fork": deltas_after_fork,
            "parent_turn_completed_after_fork": settle is not None,
            "parent_result_subtype": (settle[1].get("subtype") if settle else None),
            "parent_result_is_error": (settle[1].get("is_error") if settle else None),
            "parent_store_sha256_at_fork": at_fork["sha256"],
            "parent_store_sha256_at_result": after_at_result["sha256"],
            "parent_store_sha256_after": after["sha256"],
            "parent_store_changed_after_fork": at_fork["sha256"] != after["sha256"],
            # The late-flush question, measured inside one run.
            "parent_store_changed_by_result": at_fork["sha256"] != after_at_result["sha256"],
            "parent_store_changed_after_result": after_at_result["sha256"] != after["sha256"],
            "parent_store_lines_at_fork": at_fork["lines"],
            "parent_store_lines_at_result": after_at_result["lines"],
            "parent_store_lines_after": after["lines"],
            "parent_store_gained_by_result": gained(at_fork["raw"], after_at_result["raw"]),
            "parent_store_gained": parent_gained,
            "store_resolved": path is not None,
            "baseline_store_exists": baseline["exists"],
            "disk_read_earned": fork_disk_earned,
            "parent_stderr_tail": child.stderr_tail.strip()[-400:] or None,
            "result": ("measured" if (streaming["streaming_confirmed"] and streaming_at_fork
                                      and fork_disk_earned) else "unearned"),
        }
    finally:
        if fork_child:
            fork_child.close()
        if child:
            child.close()
        shutil.rmtree(work, ignore_errors=True)


CELLS = {
    "kill": ("claude_kill_mid_stream", cell_kill_mid_stream),
    "fork": ("claude_fork_beside", cell_fork_beside),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--timeout", type=float, default=120.0,
                    help="seconds to wait for a turn to settle (default: 120)")
    ap.add_argument("--cell", choices=tuple(CELLS), action="append",
                    help="repeatable; default is both")
    args = ap.parse_args()

    if shutil.which("claude") is None:
        print("!! claude not on PATH", file=sys.stderr)
        return 2

    record = {"captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "cli_version": claude_version(),
              "model_flag": MODEL,
              "spawned_without_direnv_sbox": True,
              "cells": {}}

    for key in (args.cell or list(CELLS)):
        name, fn = CELLS[key]
        print(f"=== Claude: {name} ===", file=sys.stderr)
        record["cells"][name] = fn(args.timeout)

    print(json.dumps(record, indent=2))

    # Non-zero if any cell could not confirm the parent was streaming when it
    # acted -- that makes everything the cell reports about the parent unearned.
    ok = all(cell.get("result") == "measured" for cell in record["cells"].values())
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
