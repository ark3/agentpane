#!/usr/bin/env python3
"""Fork-from-past probe — the 2x2 of {Pi, Codex} x {rewind, new session},
plus a Codex mid-stream cell.

`DESIGN.md:21` and HANDOFF finding 7 claim "both backends support fork-from-past
natively". Nothing had ever run a fork on either backend; this probe runs all
five cells against the live CLIs on this machine, prints a record for each
(does the operation exist? what did it return? what did it leave on disk?), and
captures a forked-or-branched session fixture per backend so the mapping work
can proceed on a machine that cannot run either CLI.

The cells (see OW-mewiga, docs/HANDOFF.md findings 7/18/19/21/30, and
OW-gojado for the fifth):

  Pi, rewind        -> RPC `fork` (entryId). On 0.84.2 this is COPY-ON-WRITE,
                       not the in-place rewrite the adapter docblock describes
                       (pi/process.ts:343): the active file is left
                       byte-identical and the post-fork re-ask lands in a NEW
                       file with a `parentSession` pointer. The process's active
                       `sessionFile` MOVES to that new file at the fork call
                       itself (OW-pifowo). On the 2026-08-20 second-message
                       run the rewound branch stops BEFORE the forked-at user
                       message, matching Codex's edit contract. Whether the
                       moved-to file is on disk AT the fork is UNSETTLED: the
                       two runs read opposite answers and did not measure at
                       the same point (OW-gajesu), so the get_state re-query is
                       back ahead of get_messages where OW-pifowo took it. A
                       mid-stream fork also succeeds, but it aborts the running
                       turn and leaves the new branch empty/idle. Proven by
                       inspection, not by the response --
                       an extension veto reports success:true with
                       cancelled:true, finding 30.
  Pi, new session   -> RPC `clone`. Takes NO entry id (rpc.md "clone"): it
                       duplicates the whole active branch into a NEW session
                       file at the current position, with a `parentSession`
                       lineage pointer. The RPC process does not switch to it,
                       so branching-from-a-point on Pi is fork+clone, or
                       clone+switch_session. This probe clones, switches to the
                       clone, and drives a real turn INSIDE it.
  Codex, new session-> `thread/fork` with `lastTurnId` (inclusive). Mints a new
                       thread id; the on-disk rollout carries `forked_from_id`.
                       This probe forks, then drives a real turn in the fork.
                       Its `parent_untouched` flag is a header read, not a
                       before/after comparison -- see the note at that line, and
                       the mid-stream cell for what a real one looks like.
  Codex, mid-stream -> `thread/fork` fired while the PARENT is mid-turn, the
                       one condition D15 turns on and the only cell here that
                       reads the parent rather than the fork. Confirms the turn
                       is streaming first (`turn/started` plus accumulating
                       `item/agentMessage/delta`s), re-reads the buffer at the
                       instant the fork request goes out -- the threshold being
                       met is not the turn still running when the request lands
                       -- and refuses to report a result it did not earn, on the
                       wire OR on disk: a parent rollout it could not resolve,
                       one that was not there to begin with, or one whose
                       already-written lines moved under it all fail the cell
                       too, because the finding is what that file GAINED and a
                       file that was never found gains nothing in exactly the
                       same way (OW-wifibe). Then records whether deltas keep
                       arriving, whether `turn/completed` lands and with what
                       status, and whether assistant text reaches the parent
                       rollout -- hashed at the fork and again after, since the
                       new-session cell's header-only `parent_untouched` check
                       cannot answer this (OW-gojado). On 0.154.0 the parent
                       SURVIVES: deltas keep arriving, the turn completes, and
                       the full reply lands in the parent rollout -- the
                       opposite of Pi's mid-stream fork. The cell also records
                       the KIND of every rollout line the parent gained,
                       because it deletes its CODEX_HOME and that census is all
                       a later reader gets; it is how the 0.147.0 -> 0.154.0
                       rollout shape change was caught.
  Codex, rewind     -> `thread/rollback`. Marked DEPRECATED ("will be removed
                       soon") in the generated schema; there is no
                       non-deprecated in-place rewind. "Codex cannot rewind" is
                       the RESULT, reported, not a failure. This probe records
                       the deprecation from the live schema rather than firing
                       a deprecated command.

Constraints honoured (OW-mewiga):
  * NEVER fork a corpus session -- everything here runs in throwaway workspaces
    with throwaway state dirs (PI_CODING_AGENT_DIR / CODEX_HOME), credentials
    copied in by name. That was initially a safety hedge against the
    possibility that Pi rewrote a session in place; the hedge remains cheap.
  * NOT `ephemeral: true` for Codex -- the on-disk residue IS the question here,
    so threads must materialise on disk (contrast capture_fixtures.py, which
    uses ephemeral to stay clean; finding 25).
  * A returned id proves nothing: every new-session cell ends with a completed
    assistant turn INSIDE the forked session, and rewind is proven against disk.

Usage:
    python3 fork_probe.py                 # run all five cells, write fixtures
    python3 fork_probe.py --no-fixtures   # record only, don't touch fixtures/
    python3 fork_probe.py --timeout 90

Needs: `pi` and `codex` on PATH with working credentials, and a writable temp
area. Costs tokens: each new-session cell drives real model turns, and the
mid-stream cell drives one it deliberately does not let finish quickly.

Framing note: Pi RPC is LF-only. This reads text-mode line-by-line, which is
adequate here because the probe's own prompts never embed U+2028/U+2029; the
byte-splitting Recorder in capture_fixtures.py is the reference for a harness
that cannot assume that.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
FIXTURES = REPO / "resources" / "fixtures"

PI_STATE_FILES = ("auth.json", "models.json", "models-store.json",
                  "settings.json", "trust.json")
CODEX_STATE_FILES = ("auth.json", "config.toml")

# Fixtures get committed, so identifying values are replaced with structurally
# equivalent placeholders on the way out (same policy as capture_fixtures.py).
SCRUB_KEYS = {
    "model": "example-model",
    "provider": "example-provider",
    "modelProvider": "example-provider",
    "model_provider": "example-provider",
    "api": "example-api-stream",
    "baseUrl": "https://example.invalid/api",
    "originator": "example-originator",
    "userAgent": "agentpane-fixture-probe/0.0.0 (example-os; x86_64)",
}


def collect_sensitive(obj, found):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in SCRUB_KEYS and isinstance(v, str) and v:
                found[v] = SCRUB_KEYS[k]
            collect_sensitive(v, found)
    elif isinstance(obj, list):
        for v in obj:
            collect_sensitive(v, found)


# The by-key scrub above cannot see operator data embedded in captured *content*
# -- Codex replays the host's skills manifest into the turn context, so a fork
# fixture ends up carrying the operator's home path and private SKILL.md list in
# message text and in the `host_skills` world-state block. Neutralise those in
# place (structure preserved: this fixture exists for fork lineage and the
# post-fork turn, not for the skills content).
SKILLS_PLACEHOLDER = (
    "[operator skills manifest scrubbed -- see resources/fixtures/README.md]"
)


def scrub_content(obj):
    """Recursively blank operator-identifying content. Returns edit count."""
    n = 0
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if (
                k == "host_skills"
                and isinstance(v, dict)
                and isinstance(v.get("body"), str)
                and ("## Skills" in v["body"] or "/home/" in v["body"])
            ):
                v["body"] = SKILLS_PLACEHOLDER
                n += 1
            elif isinstance(v, str) and v.lstrip().startswith("<skills_instructions>"):
                obj[k] = (
                    "<skills_instructions>\n"
                    + SKILLS_PLACEHOLDER
                    + "\n</skills_instructions>"
                )
                n += 1
            else:
                n += scrub_content(v)
    elif isinstance(obj, list):
        for v in obj:
            n += scrub_content(v)
    return n


def scrub_lines(raw):
    found = {}
    for line in raw:
        try:
            collect_sensitive(json.loads(line), found)
        except ValueError:
            continue
    out = []
    for line in raw:
        try:
            obj = json.loads(line)
        except ValueError:
            out.append(line)
            continue
        if scrub_content(obj):
            line = json.dumps(obj)
        for real, placeholder in found.items():
            line = line.replace(f'"{real}"', f'"{placeholder}"')
        out.append(line)
    return out


def make_state_home(real_dir, names, prefix):
    home = Path(tempfile.mkdtemp(prefix=prefix))
    for name in names:
        src = real_dir / name
        if src.exists():
            shutil.copy(src, home / name)
    return home


def make_workspace(prefix):
    work = Path(tempfile.mkdtemp(prefix=prefix))
    subprocess.run(["git", "init", "-q"], cwd=work, check=True)
    return work


def cli_version(cmd):
    try:
        out = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=30)
        return (out.stdout or out.stderr).strip().splitlines()[-1]
    except Exception as exc:  # noqa: BLE001
        return f"<unknown: {exc}>"


def text_of(message):
    """Concatenate the text blocks of a Pi AgentMessage or a raw string body."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if b.get("type") == "text")
    return ""


def preview(text, limit=120):
    """Bound recorded text so the probe output stays readable."""
    if text is None or len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def summarize_messages(messages, limit=120):
    """Project AgentMessage-like objects to compact role/text pairs."""
    return [
        {"role": message.get("role"), "text": preview(text_of(message), limit)}
        for message in messages
        if message.get("role") in {"user", "assistant"}
    ]


def pi_last_message_text(path):
    """Text of the last `message` entry in a Pi session file (for a tail check)."""
    last = None
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        e = json.loads(line)
        if e.get("type") == "message":
            last = e
    return text_of(last.get("message", {})) if last else None


def pi_file_messages(path, limit=120):
    """Project on-disk Pi `message` entries to compact role/text pairs."""
    out = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        role = message.get("role")
        if role in {"user", "assistant"}:
            out.append({"role": role, "text": preview(text_of(message), limit)})
    return out


def pi_tree_summary(path):
    """Parent -> children map plus leaves, so a branch is visible on disk."""
    entries = [json.loads(l) for l in open(path) if l.strip()]
    children = {}
    parents = set()
    ids = []
    for e in entries:
        eid = e.get("id")
        if eid is None:
            continue
        ids.append(eid)
        pid = e.get("parentId")
        parents.add(pid)
        children.setdefault(pid, []).append(eid)
    branch_points = {p: c for p, c in children.items() if p is not None and len(c) > 1}
    leaves = [i for i in ids if i not in parents]
    return {"entry_count": len(entries), "branch_points": branch_points, "leaves": leaves}


# ----------------------------------------------------------------------------
# Pi RPC driver
# ----------------------------------------------------------------------------

class PiSession:
    def __init__(self, work, home, sessdir):
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(home))
        self.proc = subprocess.Popen(
            ["pi", "--mode", "rpc", "--session-dir", str(sessdir)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, cwd=work, env=env,
        )
        self.lock = threading.Lock()
        self.raw = []
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if line:
                self.raw.append(line)

    def send(self, obj):
        with self.lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()

    def response(self, obj, command, timeout=20):
        # Scan only lines that arrive AFTER this send -- the same shape `turn`
        # uses. Scanning `self.raw` from the start returned the FIRST cached
        # response to a command on a second call, so a re-query of get_state
        # silently echoed the pre-fork state. The `pi_rewind` cell re-queries
        # get_state right after the fork to observe the active file move, so
        # this correctness is load-bearing (OW-pifowo).
        mark = len(self.raw)
        self.send(obj)
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.raw[mark:]:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("type") == "response" and e.get("command") == command:
                    return e
            time.sleep(0.15)
        return None

    def turn(self, text, timeout=60):
        mark = len(self.raw)
        self.send({"type": "prompt", "message": text})
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.raw[mark:]:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("type") == "agent_settled":
                    return True
            time.sleep(0.2)
        return False

    def last_assistant_text(self, since=0):
        for line in reversed(self.raw[since:]):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant":
                return text_of(e["message"])
        return None

    def wait_for_event(self, event_type, since=0, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.raw[since:]:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") == event_type:
                    return event
            time.sleep(0.15)
        return None

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def run_pi(timeout, want_fixtures):
    cells = {}
    work = make_workspace("agentpane-fork-piwork-")
    home = make_state_home(Path.home() / ".pi" / "agent", PI_STATE_FILES, "agentpane-fork-pihome-")
    sessdir = work / "sessions"
    fixture_lines = None
    pi = PiSession(work, home, sessdir)
    try:
        st = pi.response({"type": "get_state"}, "get_state")
        version = cli_version("pi")
        # Prime: three turns so a fork at the SECOND user message is distinct
        # from both "keep nothing" and "keep the whole first turn".
        pi.turn("Say exactly: ALPHA")
        pi.turn("Say exactly: BETA")
        pi.turn("Say exactly: GAMMA")
        active = pi.response({"type": "get_state"}, "get_state")["data"]["sessionFile"]
        forks = pi.response({"type": "get_fork_messages"}, "get_fork_messages")["data"]["messages"]

        # --- Cell: Pi rewind (fork). Rewind to the SECOND user message (BETA),
        #     then re-ask. The UNKNOWN this settles: does the rewound branch
        #     keep the user message it forked at, or does it stop before it?
        #
        #     On 0.84.2 the answer is that `fork` is COPY-ON-WRITE, not an
        #     in-place rewrite of the active file (contra the adapter docblock
        #     at pi/process.ts:343, which says it "rewinds the active branch of
        #     the SAME session file in place"). The original file is left
        #     byte-identical; the post-fork re-ask lands in a NEW file carrying
        #     a `parentSession` pointer back to it. Survival is therefore total:
        #     the whole prior branch is preserved as its own intact file. The
        #     probe proves it three ways -- the original file's sha is unchanged,
        #     its last entry is still the abandoned GAMMA assistant reply, and
        #     a new file appears whose header points back at it.
        #
        #     It also settles OW-pifowo's ref question: the process's active
        #     `sessionFile` MOVES to the new file at the fork call itself,
        #     BEFORE any re-ask (`active_file_moves_at_fork`). On the
        #     2026-08-20 run the moved-to file was already present on disk by
        #     the immediate `get_state` re-query, so the adapter concern is
        #     simply to re-adopt the file Pi reports after a fork rather than
        #     keep steering the abandoned pre-fork branch. ---
        beta_entry = forks[1]["entryId"]
        beta_text = forks[1]["text"]
        orig_sha_before = hashlib.sha256(open(active, "rb").read()).hexdigest()
        orig_tail_before = pi_last_message_text(active)
        pre_fork_files = {p.name for p in sessdir.rglob("*.jsonl")}
        fork_resp = pi.response({"type": "fork", "entryId": beta_entry}, "fork")
        # OW-pifowo: re-query get_state the moment the fork returns, before any
        # re-ask, to catch the active file moving and to see whether the moved-to
        # file is on disk yet. This must stay the FIRST round-trip after `fork`:
        # the 2026-08-20 run put a get_messages ahead of it and read the opposite
        # answer from 2026-08-19, which leaves that extra latency as a candidate
        # explanation and makes the two runs incomparable (OW-gajesu).
        active_after_fork = pi.response({"type": "get_state"}, "get_state")["data"]["sessionFile"]
        files_at_fork = {p.name for p in sessdir.rglob("*.jsonl")}
        rewound_messages = pi.response({"type": "get_messages"}, "get_messages")["data"]["messages"]
        moved_on_disk_at_fork = (
            active_after_fork is not None and Path(active_after_fork).name in files_at_fork
        )
        # If it IS there, what does it hold before any prompt? That is what a
        # fork the user then discards would leave behind for the session picker
        # to list (OW-gajesu).
        moved_file_messages_at_fork = (
            pi_file_messages(active_after_fork) if moved_on_disk_at_fork else None
        )
        # Re-ask from the rewound point so a new branch actually forms.
        pi.turn("Say exactly: DELTA")
        time.sleep(0.5)
        rewound_messages_after_reask = pi.response({"type": "get_messages"}, "get_messages")["data"]["messages"]
        orig_sha_after = hashlib.sha256(open(active, "rb").read()).hexdigest()
        orig_tail_after = pi_last_message_text(active)
        rewind_new_files = [p for p in sessdir.rglob("*.jsonl") if p.name not in pre_fork_files]
        new_file = rewind_new_files[0] if rewind_new_files else None
        new_header = json.loads(open(new_file).readline()) if new_file else {}
        rewound_file_messages = pi_file_messages(new_file) if new_file else []
        cells["pi_rewind"] = {
            "operation": "fork (entryId)",
            "exists": fork_resp is not None and fork_resp.get("success") is True,
            "returned": fork_resp.get("data") if fork_resp else None,
            "rewound_to_entry": beta_entry,
            "rewound_to_text": beta_text,
            "in_place_rewrite_of_active_file": False,
            "copy_on_write": True,
            "original_file_unchanged": orig_sha_before == orig_sha_after,
            "original_tail_still_abandoned_branch": orig_tail_before == orig_tail_after,
            "original_abandoned_tail_text": orig_tail_after,
            "reask_wrote_new_file": new_file.name if new_file else None,
            "new_file_parentSession": new_header.get("parentSession"),
            "rewound_messages_before_reask": summarize_messages(rewound_messages),
            "forked_message_present_in_get_messages": any(
                message.get("role") == "user" and text_of(message) == beta_text
                for message in rewound_messages
            ),
            "rewound_messages_after_reask": summarize_messages(rewound_messages_after_reask),
            "rewound_file_messages_after_reask": rewound_file_messages,
            "forked_message_present_on_disk_after_reask": any(
                message["role"] == "user" and message["text"] == beta_text
                for message in rewound_file_messages
            ),
            # OW-pifowo ref question: the active file moves at the fork call.
            # Whether it is on disk by then is unsettled -- the two runs disagree
            # (OW-gajesu). The move itself is the stable fact the adapter needs.
            "active_file_moves_at_fork": active_after_fork != active,
            "active_file_after_fork": Path(active_after_fork).name if active_after_fork else None,
            "moved_file_on_disk_at_fork": moved_on_disk_at_fork,
            "moved_file_messages_at_fork": moved_file_messages_at_fork,
            "abandoned_tail_survives_on_disk": (orig_sha_before == orig_sha_after) and new_file is not None,
            "note": "The response cannot be trusted for the veto path (finding 30), "
                    "so survival is read off disk: the original file is untouched "
                    "and the re-ask spins off a lineage-linked new file. Separately, "
                    "81/419 corpus files carry in-file sibling branches under one "
                    "parent (the TUI /fork shape) -- both routes preserve, neither "
                    "destroys, so no destructive-rewind warning is warranted.",
        }

        # --- Cell: Pi new session (clone). No entryId; whole active branch to a
        #     new file. Switch to it and drive a real turn INSIDE it. ---
        pre_files = {p.name for p in sessdir.rglob("*.jsonl")}
        active_now = pi.response({"type": "get_state"}, "get_state")["data"]["sessionFile"]
        clone_resp = pi.response({"type": "clone"}, "clone")
        time.sleep(0.5)
        new_files = [p for p in sessdir.rglob("*.jsonl") if p.name not in pre_files]
        clone_file = new_files[0] if new_files else None
        clone_header = json.loads(open(clone_file).readline()) if clone_file else {}
        # Switch the RPC process to the clone and drive a turn there.
        turn_ok = False
        clone_reply = None
        clone_after = None
        if clone_file:
            pi.response({"type": "switch_session", "sessionPath": str(clone_file)}, "switch_session")
            switched = pi.response({"type": "get_state"}, "get_state")["data"]["sessionFile"]
            mark = len(pi.raw)
            turn_ok = pi.turn("Say exactly: EPSILON")
            clone_reply = pi.last_assistant_text(mark)
            clone_after = pi_tree_summary(clone_file)
        cells["pi_new_session"] = {
            "operation": "clone (no entryId) + switch_session",
            "exists": clone_resp is not None and clone_resp.get("success") is True,
            "returned": clone_resp.get("data") if clone_resp else None,
            "clone_takes_entry_id": False,
            "clone_copies_whole_active_branch": True,
            "new_file_created": clone_file.name if clone_file else None,
            "clone_lineage_parentSession": clone_header.get("parentSession"),
            "process_auto_switched_to_clone": False,
            "drove_turn_in_clone": turn_ok,
            "assistant_reply_in_clone": clone_reply,
            "clone_entry_count_after_turn": clone_after["entry_count"] if clone_after else None,
        }
        if want_fixtures and clone_file:
            # Scrub and keep the clone's lines HERE, not after the cells finish:
            # the mid-stream cell below drives another turn into this same clone
            # branch and then forks off it, so a read deferred to the end of
            # run_pi would bake that abandoned turn into the fixture.
            fixture_lines = scrub_lines([l for l in open(clone_file) if l.strip()])

        # Still inside the Pi rewind cell: fork while a turn is streaming from
        # an already-completed branch, then record both the command result and
        # what became of the in-flight turn.
        #
        # Fork at the SECOND user message, not the first. At the first, the
        # exclusive semantics proved above leave the new branch empty whatever
        # became of the running turn, so `messageCount: 0` after the fork says
        # nothing -- which is how the 2026-08-20 run recorded it (OW-gajesu).
        # Here the rewound branch should carry the first turn, so an empty one
        # is a result rather than a tautology.
        stream_forks = pi.response({"type": "get_fork_messages"}, "get_fork_messages")["data"]["messages"]
        stream_entry = stream_forks[1]["entryId"] if len(stream_forks) > 1 else None
        stream_expected_messages = 2 if stream_entry else None
        stream_prompt = "Write the numbers 1 through 400, one per line, with no prose."
        stream_mark = len(pi.raw)
        prompt_resp = pi.response({"type": "prompt", "message": stream_prompt}, "prompt")
        agent_started = pi.wait_for_event("agent_start", since=stream_mark, timeout=10)
        state_while_streaming = pi.response({"type": "get_state"}, "get_state")
        stream_fork_resp = (
            pi.response({"type": "fork", "entryId": stream_entry}, "fork", timeout=10)
            if stream_entry else None
        )
        state_after_stream_fork = pi.response({"type": "get_state"}, "get_state")
        settled_after_stream_fork = pi.wait_for_event("agent_settled", since=stream_mark, timeout=timeout) is not None
        post_stream_state = pi.response({"type": "get_state"}, "get_state")
        post_stream_messages = pi.response({"type": "get_messages"}, "get_messages")["data"]["messages"]
        # What became of the turn, read off the file it was streaming into rather
        # than off the branch the fork moved us to -- an empty NEW branch is what
        # the fork produced, not what the abandoned turn left behind.
        streaming_file = ((state_while_streaming or {}).get("data") or {}).get("sessionFile")
        abandoned_messages = (
            pi_file_messages(streaming_file)
            if streaming_file and Path(streaming_file).exists() else None
        )
        cells["pi_rewind"].update({
            "midstream_fork_entry": stream_entry,
            "midstream_expected_message_count": stream_expected_messages,
            "midstream_abandoned_file": Path(streaming_file).name if streaming_file else None,
            "midstream_abandoned_file_messages": abandoned_messages,
            "midstream_prompt_admitted": prompt_resp is not None and prompt_resp.get("success") is True,
            "midstream_agent_start_seen": agent_started is not None,
            "midstream_state_before_fork": state_while_streaming.get("data") if state_while_streaming else None,
            "midstream_fork_return": stream_fork_resp,
            "midstream_state_after_fork": state_after_stream_fork.get("data") if state_after_stream_fork else None,
            "midstream_turn_settled": settled_after_stream_fork,
            "midstream_state_after_turn": post_stream_state.get("data") if post_stream_state else None,
            "midstream_assistant_reply_preview": preview(pi.last_assistant_text(stream_mark)),
            "midstream_messages_tail": summarize_messages(post_stream_messages[-4:]),
        })
    finally:
        pi.close()

    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)
    return version, cells, fixture_lines


# ----------------------------------------------------------------------------
# Codex app-server driver
# ----------------------------------------------------------------------------

def codex_rollout_for(home, thread_id):
    """The rollout file whose session_meta header names `thread_id`, or None."""
    for f in sorted((home / "sessions").rglob("*.jsonl")):
        try:
            with open(f, "rb") as fh:
                header = json.loads(fh.readline()).get("payload", {})
        except (ValueError, OSError):
            continue
        if header.get("id") == thread_id:
            return f
    return None


def codex_rollout_lines(path):
    """A rollout's non-blank lines, split on BYTES.

    One representation for every line index in this probe. `str.splitlines`
    also breaks on U+2028, U+2029 and U+0085, and Codex rollouts are serde_json
    output that emits those raw inside text -- so a str split and a bytes split
    of the same file disagree on how many lines it has, and an index taken
    under one is meaningless under the other. This module's docstring already
    names U+2028/U+2029 as the framing hazard here.
    """
    if path is None or not path.exists():
        return []
    return [l for l in path.read_bytes().splitlines() if l.strip()]


def codex_rollout_snapshot(path):
    """Whether a rollout exists, its sha256, and its lines, for a before/after
    comparison.

    The Pi mid-stream cell hashes the file across the fork; this is the Codex
    equivalent, and it is deliberately not the header-only `forked_from_id`
    check the codex_new_session cell makes.

    The lines come back beside the hash because the mid-stream cell checks that
    the file only GAINED, and `exists` because a file that was never found
    hashes to the same `None` a file that never changed would. Both feed that
    cell's `disk_read_earned` gate.
    """
    if path is None or not path.exists():
        return {"exists": False, "sha256": None, "lines": 0, "raw": []}
    raw = codex_rollout_lines(path)
    return {"exists": True, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "lines": len(raw), "raw": raw}


def codex_rollout_gained(path, from_line, limit=400):
    """What a rollout gained after `from_line`: every line's kind, and any
    assistant text.

    The census is the point, not a detail. This cell deletes its CODEX_HOME on
    the way out, so the rollout the claim rests on survives nowhere and the JSON
    record is the only artifact a later reader gets. Recording the `type` /
    `payload.type` / `role` of every gained line lets that reader check which
    lines the text was extracted from, and notice a rollout shape that has
    changed since, without a re-run and without committing model output.
    """
    census = []
    texts = []
    for raw in codex_rollout_lines(path)[from_line:]:
        try:
            e = json.loads(raw)
        except ValueError:
            census.append({"type": "<unparsed>", "payload_type": None, "role": None})
            continue
        payload = e.get("payload", {})
        census.append({"type": e.get("type"),
                       "payload_type": payload.get("type"),
                       "role": payload.get("role")})
        found = []
        if e.get("type") == "event_msg" and payload.get("type") == "agent_message":
            found.append(payload.get("message", ""))
        elif e.get("type") == "response_item" and payload.get("role") == "assistant":
            for block in payload.get("content", []) or []:
                if block.get("text"):
                    found.append(block["text"])
        for text in found:
            # Length and tail as well as head: a truncated preview cannot tell
            # a complete reply from one that stopped partway.
            texts.append({"from": census[-1], "chars": len(text),
                          "head": preview(text, limit),
                          "tail": text[-limit:]})
    return census, texts


class CodexSession:
    def __init__(self, work, home):
        env = dict(os.environ, CODEX_HOME=str(home))
        self.proc = subprocess.Popen(
            ["codex", "app-server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, cwd=work, env=env,
        )
        self.lock = threading.Lock()
        self.events = []
        self.responses = {}
        self._t = threading.Thread(target=self._read, daemon=True)
        self._t.start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            self.events.append(e)
            if "id" in e and "method" not in e:
                self.responses[e["id"]] = e
            elif "id" in e and e.get("method"):
                # Server-initiated approval request: accept so the turn proceeds.
                self.send({"id": e["id"], "result": {"decision": "accept"}})

    def send(self, obj):
        with self.lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()

    def request(self, req_id, method, params, timeout=30):
        self.send({"id": req_id, "method": method, "params": params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            if req_id in self.responses:
                return self.responses[req_id]
            time.sleep(0.1)
        return None

    def turn(self, req_id, thread_id, text, timeout=90):
        mark = len(self.events)
        self.send({"id": req_id, "method": "turn/start",
                   "params": {"threadId": thread_id, "input": [{"type": "text", "text": text}]}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            for e in self.events[mark:]:
                if e.get("method") in ("turn/completed", "turn/failed"):
                    return e.get("method") == "turn/completed", mark
            time.sleep(0.2)
        return False, mark

    def start_turn(self, req_id, thread_id, text):
        """Fire `turn/start` and return immediately, without waiting for the turn.

        `turn()` blocks until the turn settles, which cannot express "do
        something while it is running". The caller gets the event-log mark and
        drives its own waiting.
        """
        mark = len(self.events)
        self.send({"id": req_id, "method": "turn/start",
                   "params": {"threadId": thread_id, "input": [{"type": "text", "text": text}]}})
        return mark

    def events_since(self, mark, method, thread_id):
        """Notifications of `method` for `thread_id` since `mark`.

        The thread filter is not optional: this driver's whole use is watching
        a parent while a fork of it exists in the same process, and an unfiltered
        count would silently mix the two.
        """
        return [e for e in self.events[mark:]
                if e.get("method") == method
                and e.get("params", {}).get("threadId") == thread_id]

    def await_streaming(self, mark, thread_id, min_deltas, timeout):
        """Block until the turn is positively observed streaming.

        Two independent signals, both required: `turn/started` for this thread,
        and at least `min_deltas` `item/agentMessage/delta` notifications for
        it. Sleeping and hoping would let a fork land on a finished turn and
        report nothing, silently. Returns the observation either way -- the
        caller decides what an unmet signal means.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            started = self.events_since(mark, "turn/started", thread_id)
            deltas = self.events_since(mark, "item/agentMessage/delta", thread_id)
            settled = self.events_since(mark, "turn/completed", thread_id)
            if settled:
                break
            if started and len(deltas) >= min_deltas:
                return {"turn_started_seen": True, "deltas_before_fork": len(deltas),
                        "settled_before_fork": False, "streaming_confirmed": True,
                        "turn_id": started[0]["params"]["turn"]["id"]}
            time.sleep(0.1)
        started = self.events_since(mark, "turn/started", thread_id)
        settled = self.events_since(mark, "turn/completed", thread_id)
        return {
            "turn_started_seen": bool(started),
            "deltas_before_fork": len(self.events_since(mark, "item/agentMessage/delta", thread_id)),
            "settled_before_fork": bool(settled),
            "streaming_confirmed": False,
            "turn_id": started[0]["params"]["turn"]["id"] if started else None,
        }

    def still_streaming(self, mark, thread_id):
        """Re-read the buffer at the instant of the action.

        `await_streaming` returns the moment its threshold is met, and the turn
        can settle in the gap between that return and the fork request going
        out -- which is how the first run of `claude_fork_probe.py` killed a
        turn that had already finished. `streaming_confirmed` cannot see that
        gap: it was decided before it opened. This is the check the cell
        records beside the fork itself, and `claude_fork_probe.py`'s
        `still_streaming` is its sibling.
        """
        return not self.events_since(mark, "turn/completed", thread_id)

    def await_turn_end(self, mark, thread_id, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            settled = self.events_since(mark, "turn/completed", thread_id)
            if settled:
                return settled[0]
            time.sleep(0.2)
        return None

    def agent_text_since(self, mark):
        for e in self.events[mark:]:
            if e.get("method") == "item/completed":
                item = e.get("params", {}).get("item", {})
                if item.get("type") == "agentMessage":
                    return item.get("text")
        return None

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def codex_rollback_deprecation():
    """Record whether thread/rollback is still deprecated in the live schema.

    Generates the current JSON schema into a temp dir and reads
    ThreadRollbackParams' description. This is the Codex-rewind cell: rather
    than fire a deprecated command, record the harness's own statement about it.
    """
    out = Path(tempfile.mkdtemp(prefix="agentpane-fork-schema-"))
    try:
        subprocess.run(["codex", "app-server", "generate-json-schema", "--out", str(out),
                        "--experimental"], capture_output=True, text=True, timeout=60)
        client = json.load(open(out / "ClientRequest.json"))
        methods = []
        for variant in client.get("oneOf", []):
            enum = variant.get("properties", {}).get("method", {}).get("enum")
            if enum:
                methods.append(enum[0])
        rollback_def = client.get("definitions", {}).get("ThreadRollbackParams", {})
        desc = rollback_def.get("description", "")
        return {
            "method_present": "thread/rollback" in methods,
            "params_description": desc,
            "deprecated": "DEPRECATED" in desc.upper(),
            "client_request_method_count": len(methods),
        }
    finally:
        shutil.rmtree(out, ignore_errors=True)


def run_codex(timeout, want_fixtures):
    cells = {}
    version = cli_version("codex")

    # --- Cell: Codex rewind (thread/rollback). Recorded from the live schema. ---
    rb = codex_rollback_deprecation()
    cells["codex_rewind"] = {
        "operation": "thread/rollback (numTurns)",
        "exists": rb["method_present"],
        "returned": None,
        "supported": not rb["deprecated"],
        "deprecated": rb["deprecated"],
        "schema_description": rb["params_description"],
        "note": "Deprecated in the generated schema and deliberately unused "
                "(codex/adapter.ts:370). No non-deprecated in-place rewind exists; "
                "'Codex cannot rewind' is the reported result. Rewind is emulated "
                "elsewhere by forking a new thread through an earlier turn.",
    }

    # --- Cell: Codex new session (thread/fork + lastTurnId). Drive a turn in it. ---
    work = make_workspace("agentpane-fork-codexwork-")
    home = make_state_home(Path.home() / ".codex", CODEX_STATE_FILES, "agentpane-fork-codexhome-")
    fixture_src = None
    cx = CodexSession(work, home)
    try:
        cx.request(1, "initialize", {"clientInfo": {"name": "agentpane-fork-probe",
                                                     "version": "0", "title": "agentpane"}})
        # NOT ephemeral: the on-disk residue is the question here.
        started = cx.request(2, "thread/start", {})
        parent_id = started["result"]["thread"]["id"]
        ok1, _ = cx.turn(3, parent_id, "Say exactly: ALPHA", timeout)
        ok2, _ = cx.turn(4, parent_id, "Say exactly: BETA", timeout)
        read = cx.request(5, "thread/read", {"threadId": parent_id, "includeTurns": True})
        turns = read["result"]["thread"].get("turns", [])
        # Fork through the first turn (inclusive): keep ALPHA, drop BETA.
        last_turn_id = turns[0]["id"] if turns else None
        fork = cx.request(6, "thread/fork",
                          {"threadId": parent_id,
                           **({"lastTurnId": last_turn_id} if last_turn_id else {}),
                           "cwd": str(work)})
        fthread = fork["result"]["thread"]
        forked_id = fthread["id"]
        # OW-22: BEFORE driving any turn in the fork, is the forked rollout
        # already flushed to disk and readable? The route once feared the index
        # "may not see a thread the backend has not flushed". On 0.148.0 it is
        # flushed immediately: the rollout exists with `forked_from_id` set and
        # thread/read returns it before GAMMA. So the returned ref attaches
        # fresh with no flush race.
        time.sleep(0.5)
        pre_turn_rollouts = {}
        for f in sorted((home / "sessions").rglob("*.jsonl")):
            h = json.loads(open(f).readline()).get("payload", {})
            pre_turn_rollouts[h.get("id")] = h.get("forked_from_id")
        forked_on_disk_before_turn = forked_id in pre_turn_rollouts
        read_before = cx.request(9, "thread/read", {"threadId": forked_id, "includeTurns": True})
        thread_read_forked_before_turn_ok = read_before is not None and "result" in read_before
        # Drive a real turn INSIDE the fork.
        turn_ok, mark = cx.turn(7, forked_id, "Say exactly: GAMMA", timeout)
        fork_reply = cx.agent_text_since(mark)
        cx.close()
        time.sleep(0.5)
        # On-disk residue.
        rollouts = {}
        for f in sorted((home / "sessions").rglob("*.jsonl")):
            header = json.loads(open(f).readline()).get("payload", {})
            rollouts[header.get("id")] = {
                "file": f.name,
                "forked_from_id": header.get("forked_from_id"),
                "thread_source": header.get("thread_source"),
            }
            if header.get("id") == forked_id:
                fixture_src = f
        cells["codex_new_session"] = {
            "operation": "thread/fork (lastTurnId, inclusive)",
            "exists": fork is not None and "result" in fork,
            "returned": {"forked_thread_id": forked_id,
                         "forkedFromId": fthread.get("forkedFromId"),
                         "sessionId": fthread.get("sessionId")},
            "parent_thread_id": parent_id,
            "forked_through_turn": last_turn_id,
            "drove_turn_in_fork": turn_ok,
            "assistant_reply_in_fork": fork_reply,
            # OW-22: the fork is flushed and readable before any turn is driven.
            "forked_on_disk_before_turn": forked_on_disk_before_turn,
            "forked_from_id_before_turn": pre_turn_rollouts.get(forked_id),
            "thread_read_forked_before_turn_ok": thread_read_forked_before_turn_ok,
            "on_disk_forked_from_id": rollouts.get(forked_id, {}).get("forked_from_id"),
            # NOT a before/after comparison, and not strong enough to carry
            # one: this reads the parent header's own `forked_from_id`, which
            # says the parent is not itself a fork. It cannot see whether the
            # parent's file changed, and it says nothing at all about a parent
            # that was mid-turn -- that question belongs to the
            # codex_fork_mid_stream cell below, which sha256s the file across
            # the fork and reads what it gained (OW-gojado, D15).
            "parent_untouched": rollouts.get(parent_id, {}).get("forked_from_id") is None,
            "rollout_files": rollouts,
        }
    finally:
        if cx.proc.poll() is None:
            cx.close()

    fixture_lines = None
    if want_fixtures and fixture_src:
        fixture_lines = scrub_lines([l for l in open(fixture_src) if l.strip()])
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)

    # --- Cell: Codex mid-stream fork. Read the PARENT, not the fork. ---
    # D15 turns on one condition no cell had ever created: `thread/fork` fired
    # while the parent is mid-turn. Everything else forks an idle thread, so
    # "the parent keeps streaming" was an inference until this cell ran. On
    # 0.154.0 it holds: the fork succeeds mid-stream, the parent keeps emitting
    # deltas, and `turn/completed` arrives with status "completed" and the whole
    # reply in the parent rollout. This cell forks in flight and reports only
    # the parent (OW-gojado).
    mid_work = make_workspace("agentpane-fork-codexmid-")
    mid_home = make_state_home(Path.home() / ".codex", CODEX_STATE_FILES, "agentpane-fork-codexmidhome-")
    cx = CodexSession(mid_work, mid_home)
    try:
        cx.request(1, "initialize", {"clientInfo": {"name": "agentpane-fork-probe",
                                                     "version": "0", "title": "agentpane"}})
        # Started the way the adapter starts one (codex/adapter.ts start(), D7a),
        # and NOT ephemeral: the parent's on-disk rollout is read below.
        started = cx.request(2, "thread/start", {"cwd": str(mid_work),
                                                 "sandbox": "danger-full-access",
                                                 "approvalPolicy": "never"})
        parent_id = started["result"]["thread"]["id"]
        started_model = started["result"].get("model")
        prime_ok, _ = cx.turn(3, parent_id, "Say exactly: ALPHA", timeout)
        read = cx.request(4, "thread/read", {"threadId": parent_id, "includeTurns": True})
        turns = read["result"]["thread"].get("turns", []) if read and "result" in read else []
        last_turn_id = turns[0]["id"] if turns else None

        parent_file = codex_rollout_for(mid_home, parent_id)

        # A turn long enough to still be running at the fork, started WITHOUT
        # blocking so the fork can be fired into it.
        long_mark = cx.start_turn(5, parent_id,
                                  "Count from 1 to 400. Print one number per line and nothing else.")
        streaming = cx.await_streaming(long_mark, parent_id, min_deltas=5, timeout=timeout)

        # Taken immediately before the request goes out, which is as close to
        # the fork as a separate disk read can get. The residual window -- send,
        # server work, response -- is attributed to *after* the fork, so any
        # error here inflates what the parent is credited with writing
        # post-fork rather than hiding it.
        before = codex_rollout_snapshot(parent_file)
        streaming_at_fork = cx.still_streaming(long_mark, parent_id)
        fork = cx.request(6, "thread/fork",
                          {"threadId": parent_id,
                           **({"lastTurnId": last_turn_id} if last_turn_id else {}),
                           "cwd": str(mid_work),
                           "sandbox": "danger-full-access",
                           "approvalPolicy": "never"},
                          timeout=timeout)
        fork_mark = len(cx.events)
        fork_ok = fork is not None and "result" in fork
        forked_id = fork["result"]["thread"]["id"] if fork_ok else None

        settle = cx.await_turn_end(fork_mark, parent_id, timeout)
        deltas_after_fork = len(cx.events_since(fork_mark, "item/agentMessage/delta", parent_id))
        turn_status = settle["params"]["turn"].get("status") if settle else None
        turn_error = settle["params"]["turn"].get("error") if settle else None
        # A returned id is not a fork (README: "a returned id alone cannot pass
        # the check"). The parent is this cell's subject, so the fork gets the
        # cheap checks rather than a turn: is it readable, and is it on disk
        # with the right lineage?
        forked_read = cx.request(8, "thread/read", {"threadId": forked_id},
                                 timeout=timeout) if fork_ok else None
        cx.close()
        time.sleep(0.5)

        forked_file = codex_rollout_for(mid_home, forked_id) if fork_ok else None
        forked_from_id = None
        if forked_file:
            with open(forked_file, "rb") as fh:
                forked_from_id = json.loads(fh.readline()).get("payload", {}).get("forked_from_id")
        after = codex_rollout_snapshot(parent_file)
        prefix_preserved = after["raw"][:len(before["raw"])] == before["raw"]
        # The wire signals cannot carry this cell on their own. Its finding is
        # what the parent rollout GAINED, and an absence there is exactly what
        # a rollout path that never resolved, or a baseline file that was not
        # on disk, also produces -- silently, and reported as "the file did not
        # change". A rollout whose already-written lines moved under the cell
        # fails it too, because then the line index `before["lines"]` hands the
        # census no longer points where it did. Taken from
        # `claude_fork_probe.py`, whose disk gate is these same three.
        disk_read_earned = (parent_file is not None and before["exists"]
                            and prefix_preserved)
        gained_census, landed = codex_rollout_gained(parent_file, before["lines"])

        cells["codex_fork_mid_stream"] = {
            "operation": "thread/fork fired while the parent turn is streaming",
            "reads": "the PARENT thread only; no turn is driven in the fork",
            "parent_thread_id": parent_id,
            "model": started_model,
            "primed_turn_ok": prime_ok,
            "forked_through_turn": last_turn_id,
            # Earned, or not reported: a fork fired at a turn that had already
            # settled measures nothing, and the failure mode is silent.
            "streaming_confirmed_before_fork": streaming["streaming_confirmed"],
            "turn_started_seen": streaming["turn_started_seen"],
            "deltas_before_fork": streaming["deltas_before_fork"],
            "parent_turn_settled_before_fork": streaming["settled_before_fork"],
            "streaming_turn_id": streaming["turn_id"],
            "still_streaming_at_the_fork_itself": streaming_at_fork,
            "fork_succeeded_mid_stream": fork_ok,
            "fork_response": fork if not fork_ok else {"forked_thread_id": forked_id},
            "forked_thread_read_ok": forked_read is not None and "result" in forked_read,
            "forked_rollout_on_disk": forked_file is not None,
            "forked_rollout_forked_from_id": forked_from_id,
            # What the parent did after the fork call.
            "parent_deltas_after_fork": deltas_after_fork,
            "parent_turn_completed_after_fork": settle is not None,
            "parent_turn_status": turn_status,
            "parent_turn_error": turn_error,
            # The parent rollout on disk, hashed just before the fork request
            # and again after the parent settled -- not the header-only
            # `parent_untouched` check the codex_new_session cell carries,
            # which D15 names as too weak to answer this.
            "parent_rollout_file": parent_file.name if parent_file else None,
            "parent_rollout_sha256_at_fork": before["sha256"],
            "parent_rollout_sha256_after": after["sha256"],
            "parent_rollout_changed_after_fork": before["sha256"] != after["sha256"],
            "parent_rollout_lines_at_fork": before["lines"],
            "parent_rollout_lines_after": after["lines"],
            # Every line the parent gained, by kind -- the audit trail for the
            # text below, since this cell's CODEX_HOME does not survive it.
            "parent_rollout_lines_gained": gained_census,
            "parent_assistant_text_after_fork": landed,
            "parent_rollout_resolved": parent_file is not None,
            "baseline_rollout_exists": before["exists"],
            "parent_rollout_prefix_preserved": prefix_preserved,
            "disk_read_earned": disk_read_earned,
            "result": ("measured" if (streaming["streaming_confirmed"] and streaming_at_fork
                                      and disk_read_earned) else "unearned"),
        }
    finally:
        if cx.proc.poll() is None:
            cx.close()
        shutil.rmtree(mid_work, ignore_errors=True)
        shutil.rmtree(mid_home, ignore_errors=True)

    return version, cells, fixture_lines


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--timeout", type=float, default=90.0,
                    help="seconds to wait for a turn to settle (default: 90)")
    ap.add_argument("--no-fixtures", action="store_true",
                    help="record only; do not write resources/fixtures/*/fork.jsonl")
    ap.add_argument("--backend", choices=("pi", "codex"), action="append",
                    help="repeatable; default is both")
    args = ap.parse_args()
    backends = args.backend or ["pi", "codex"]
    want_fixtures = not args.no_fixtures

    record = {"captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cells": {}, "cli_versions": {}}

    if "pi" in backends:
        if shutil.which("pi") is None:
            print("!! pi not on PATH", file=sys.stderr)
        else:
            print("=== Pi: rewind (fork) + new session (clone) ===", file=sys.stderr)
            version, cells, fixture = run_pi(args.timeout, want_fixtures)
            record["cli_versions"]["pi"] = version
            record["cells"].update(cells)
            if want_fixtures and fixture:
                outdir = FIXTURES / "pi"
                outdir.mkdir(parents=True, exist_ok=True)
                (outdir / "fork.jsonl").write_text("\n".join(fixture) + "\n", encoding="utf-8")
                (outdir / "fork.meta.json").write_text(json.dumps({
                    "backend": "pi", "scenario": "fork",
                    "covers": "a cloned (branched-to-new-session) Pi session with a turn driven inside it",
                    "cli_version": version,
                    "captured_at": record["captured_at"],
                    "note": "Produced by clone (whole active branch -> new file) then a turn in it. "
                            "The header carries parentSession lineage.",
                }, indent=2) + "\n", encoding="utf-8")

    if "codex" in backends:
        if shutil.which("codex") is None:
            print("!! codex not on PATH", file=sys.stderr)
        else:
            print("=== Codex: rewind (rollback, from schema) + new session (thread/fork) ===", file=sys.stderr)
            version, cells, fixture = run_codex(args.timeout, want_fixtures)
            record["cli_versions"]["codex"] = version
            record["cells"].update(cells)
            if want_fixtures and fixture:
                outdir = FIXTURES / "codex"
                outdir.mkdir(parents=True, exist_ok=True)
                (outdir / "fork.jsonl").write_text("\n".join(fixture) + "\n", encoding="utf-8")
                (outdir / "fork.meta.json").write_text(json.dumps({
                    "backend": "codex", "scenario": "fork",
                    "covers": "a forked Codex thread with a turn driven inside it",
                    "cli_version": version,
                    "captured_at": record["captured_at"],
                    "note": "Produced by thread/fork (lastTurnId inclusive) then a turn in the fork. "
                            "The session_meta header carries forked_from_id.",
                }, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(record, indent=2))
    # Non-zero if any new-session cell failed to drive a turn -- that is the
    # one criterion that a returned id cannot fake -- or if the mid-stream cell
    # reported anything but "measured", which is that cell's own verdict on
    # whether it earned what it reports. Read through `result` rather than by
    # re-listing its conditions here, so a condition added there reaches the
    # exit code without a second edit.
    ok = True
    for name in ("pi_new_session", "codex_new_session"):
        cell = record["cells"].get(name)
        if cell is not None and not cell.get("drove_turn_in_fork" if "codex" in name else "drove_turn_in_clone"):
            ok = False
    mid = record["cells"].get("codex_fork_mid_stream")
    if mid is not None and mid.get("result") != "measured":
        ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
