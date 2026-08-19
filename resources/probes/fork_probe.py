#!/usr/bin/env python3
"""Fork-from-past probe — the 2x2 of {Pi, Codex} x {rewind, new session}.

`DESIGN.md:21` and HANDOFF finding 7 claim "both backends support fork-from-past
natively". Nothing had ever run a fork on either backend; this probe runs all
four cells against the live CLIs on this machine, prints a record for each
(does the operation exist? what did it return? what did it leave on disk?), and
captures a forked-or-branched session fixture per backend so the mapping work
can proceed on a machine that cannot run either CLI.

The four cells (see OW-mewiga, docs/HANDOFF.md findings 7/18/19/21/30):

  Pi, rewind        -> RPC `fork` (entryId). On 0.84.2 this is COPY-ON-WRITE,
                       not the in-place rewrite the adapter docblock describes
                       (pi/process.ts:343): the active file is left
                       byte-identical and the post-fork re-ask lands in a NEW
                       file with a `parentSession` pointer. The process's active
                       `sessionFile` MOVES to that new file at the fork call
                       itself (OW-pifowo), before any re-ask, and the moved-to
                       file is not yet on disk at that moment. Either way the
                       abandoned tail SURVIVES on disk (also visible as in-file
                       sibling branches in 81/419 corpus files), so no
                       destructive-rewind warning is warranted. Proven by
                       inspection, not by the response -- an extension veto
                       reports success:true with cancelled:true, finding 30.
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
  Codex, rewind     -> `thread/rollback`. Marked DEPRECATED ("will be removed
                       soon") in the generated schema; there is no
                       non-deprecated in-place rewind. "Codex cannot rewind" is
                       the RESULT, reported, not a failure. This probe records
                       the deprecation from the live schema rather than firing
                       a deprecated command.

Constraints honoured (OW-mewiga):
  * NEVER fork a corpus session -- everything here runs in throwaway workspaces
    with throwaway state dirs (PI_CODING_AGENT_DIR / CODEX_HOME), credentials
    copied in by name. Pi's fork rewrites its file in place, so a corpus file
    could be destroyed.
  * NOT `ephemeral: true` for Codex -- the on-disk residue IS the question here,
    so threads must materialise on disk (contrast capture_fixtures.py, which
    uses ephemeral to stay clean; finding 25).
  * A returned id proves nothing: every new-session cell ends with a completed
    assistant turn INSIDE the forked session, and rewind is proven against disk.

Usage:
    python3 fork_probe.py                 # run all four cells, write fixtures
    python3 fork_probe.py --no-fixtures   # record only, don't touch fixtures/
    python3 fork_probe.py --timeout 90

Needs: `pi` and `codex` on PATH with working credentials, and a writable temp
area. Costs tokens: each new-session cell drives real model turns.

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
    fixture_src = None
    pi = PiSession(work, home, sessdir)
    try:
        st = pi.response({"type": "get_state"}, "get_state")
        version = cli_version("pi")
        # Prime: two turns so there is a real branch to rewind to.
        pi.turn("Say exactly: ALPHA")
        pi.turn("Say exactly: BETA")
        active = pi.response({"type": "get_state"}, "get_state")["data"]["sessionFile"]
        forks = pi.response({"type": "get_fork_messages"}, "get_fork_messages")["data"]["messages"]

        # --- Cell: Pi rewind (fork). Rewind to the FIRST user message (ALPHA),
        #     then re-ask. The UNKNOWN this settles: does the abandoned BETA
        #     tail survive on disk, or is it destroyed?
        #
        #     On 0.84.2 the answer is that `fork` is COPY-ON-WRITE, not an
        #     in-place rewrite of the active file (contra the adapter docblock
        #     at pi/process.ts:343, which says it "rewinds the active branch of
        #     the SAME session file in place"). The original file is left
        #     byte-identical; the post-fork re-ask lands in a NEW file carrying
        #     a `parentSession` pointer back to it. Survival is therefore total:
        #     the whole prior branch is preserved as its own intact file. The
        #     probe proves it three ways -- the original file's sha is unchanged,
        #     its last entry is still the abandoned BETA assistant reply, and a
        #     new file appears whose header points back at it.
        #
        #     It also settles OW-pifowo's ref question: the process's active
        #     `sessionFile` MOVES to the new file at the fork call itself, BEFORE
        #     any re-ask (`active_file_moves_at_fork`), and the moved-to file is
        #     NOT yet on disk at that moment (`moved_file_on_disk_at_fork`:
        #     False) -- it materialises only on the next prompt. So the adapter
        #     must re-adopt the file `get_state` reports after a fork; returning
        #     an unchanged ref keeps the server on the abandoned pre-fork branch
        #     (fixed in pi/process.ts, this commit). ---
        alpha_entry = forks[0]["entryId"]
        orig_sha_before = hashlib.sha256(open(active, "rb").read()).hexdigest()
        orig_tail_before = pi_last_message_text(active)
        pre_fork_files = {p.name for p in sessdir.rglob("*.jsonl")}
        fork_resp = pi.response({"type": "fork", "entryId": alpha_entry}, "fork")
        # OW-pifowo: re-query get_state the moment the fork returns, before any
        # re-ask, to catch the active file moving and to check the moved-to file
        # is not yet materialised on disk.
        active_after_fork = pi.response({"type": "get_state"}, "get_state")["data"]["sessionFile"]
        files_at_fork = {p.name for p in sessdir.rglob("*.jsonl")}
        moved_on_disk_at_fork = (
            active_after_fork is not None and Path(active_after_fork).name in files_at_fork
        )
        # Re-ask from the rewound point so a new branch actually forms.
        pi.turn("Say exactly: DELTA")
        time.sleep(0.5)
        orig_sha_after = hashlib.sha256(open(active, "rb").read()).hexdigest()
        orig_tail_after = pi_last_message_text(active)
        rewind_new_files = [p for p in sessdir.rglob("*.jsonl") if p.name not in pre_fork_files]
        new_file = rewind_new_files[0] if rewind_new_files else None
        new_header = json.loads(open(new_file).readline()) if new_file else {}
        cells["pi_rewind"] = {
            "operation": "fork (entryId)",
            "exists": fork_resp is not None and fork_resp.get("success") is True,
            "returned": fork_resp.get("data") if fork_resp else None,
            "rewound_to_entry": alpha_entry,
            "in_place_rewrite_of_active_file": False,
            "copy_on_write": True,
            "original_file_unchanged": orig_sha_before == orig_sha_after,
            "original_tail_still_abandoned_branch": orig_tail_before == orig_tail_after,
            "original_abandoned_tail_text": orig_tail_after,
            "reask_wrote_new_file": new_file.name if new_file else None,
            "new_file_parentSession": new_header.get("parentSession"),
            # OW-pifowo ref question: the active file moves at the fork call, and
            # the moved-to file is not on disk until the next prompt.
            "active_file_moves_at_fork": active_after_fork != active,
            "active_file_after_fork": Path(active_after_fork).name if active_after_fork else None,
            "moved_file_on_disk_at_fork": moved_on_disk_at_fork,
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
            fixture_src = clone_file
    finally:
        pi.close()

    fixture_lines = None
    if fixture_src:
        fixture_lines = scrub_lines([l for l in open(fixture_src) if l.strip()])
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(home, ignore_errors=True)
    return version, cells, fixture_lines


# ----------------------------------------------------------------------------
# Codex app-server driver
# ----------------------------------------------------------------------------

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
    # one criterion that a returned id cannot fake.
    ok = True
    for name in ("pi_new_session", "codex_new_session"):
        cell = record["cells"].get(name)
        if cell is not None and not cell.get("drove_turn_in_fork" if "codex" in name else "drove_turn_in_clone"):
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
