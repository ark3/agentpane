#!/usr/bin/env python3
"""Approval-policy probe -- what `approvalPolicy` does to Codex's `ServerRequest`s (OW-18).

Three questions, answered live in one run:

  (a) Does `approvalPolicy: "never"` stop the approval `ServerRequest`s?
      Two threads, same edit-provoking prompt, same `sandbox` -- one started
      with no `approvalPolicy` (app-server's own default) and one started with
      `"never"`. The control run is the point: seeing nothing under `"never"`
      proves nothing unless the same prompt provoked a request without it.

  (b) What `sandbox` and `approvalPolicy` does a *forked* thread report?
      `ThreadForkResponse` carries both fields, so the effective policy is read
      off the response rather than inferred from whether a write succeeds.
      Forks are taken from a parent started the way the adapter starts one.

  (c) Can `item/tool/requestUserInput` still arrive under `"never"`?
      That is not an approval -- it is a tool asking the user a question -- so
      it is provoked deliberately with a prompt that asks for a clarifying
      question, on a `"never"` thread. "We did not see one" is not an answer;
      the record says what was asked and what came back.

Every server-initiated request is RECORDED BEFORE it is answered. `fork_probe.py`'s
session auto-accepts in its reader thread, which would answer (a) wrongly.

Usage:  python3 approval_policy_probe.py            # all cells, JSON record on stdout
        python3 approval_policy_probe.py --timeout 120

Needs: `codex` on PATH with working credentials. Costs tokens: each cell drives a
real model turn. Writes no fixtures.

Codex needs a *writable* `CODEX_HOME`; the real `~/.codex/{auth.json,config.toml}`
are copied by name into a temp home (never printed) and the copy is removed on
exit. Threads are `ephemeral: true` except the fork parent, which has to
materialise on disk for `thread/fork` to load it.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

CODEX_STATE_FILES = ("auth.json", "config.toml")

# Approval-shaped server requests, per resources/codex-protocol/ServerRequest.ts.
APPROVAL_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
}
USER_INPUT_METHOD = "item/tool/requestUserInput"


def cli_version(exe):
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20)
        return (out.stdout or out.stderr).strip()
    except Exception as exc:  # pragma: no cover - diagnostic only
        return f"<unavailable: {exc}>"


class CodexSession:
    """A live `codex app-server` over stdio that records requests before answering."""

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
        self.server_requests = []
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
                # Record first, answer second: the arrival is the measurement.
                self.server_requests.append({"method": e["method"], "params": e.get("params")})
                self.send({"id": e["id"], "result": self._answer(e)})

    @staticmethod
    def _answer(e):
        if e["method"] == USER_INPUT_METHOD:
            questions = (e.get("params") or {}).get("questions") or []
            return {"answers": {q.get("id", ""): {"answers": ["probe"]} for q in questions}}
        return {"decision": "accept"}

    def send(self, obj):
        with self.lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()

    def request(self, req_id, method, params, timeout=60):
        self.send({"id": req_id, "method": method, "params": params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            if req_id in self.responses:
                return self.responses[req_id]
            time.sleep(0.1)
        return None

    def turn(self, req_id, thread_id, text, timeout=120):
        mark = len(self.events)
        self.send({"id": req_id, "method": "turn/start",
                   "params": {"threadId": thread_id, "input": [{"type": "text", "text": text}]}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            for e in self.events[mark:]:
                if e.get("method") in ("turn/completed", "turn/failed"):
                    return e.get("method"), mark
            time.sleep(0.2)
        return "timeout", mark

    def requests_since(self, index):
        return self.server_requests[index:]

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def new_workspace():
    work = tempfile.mkdtemp(prefix="agentpane-approval-work-")
    subprocess.run(["git", "init", "-q"], cwd=work)
    Path(work, "notes.txt").write_text("alpha\n")
    return work


EDIT_PROMPT = (
    "Edit the file notes.txt in the current directory so its only line reads "
    "'beta'. Use your file-editing tool to make the change, then stop."
)

ASK_PROMPT = (
    "Before doing anything at all, use your tool for asking the user a question "
    "to ask me which of 'red' or 'blue' I want written into notes.txt. Do not "
    "guess and do not proceed until you have my answer."
)


ASK_PROMPT2 = (
    "You have a tool that sends the user a multiple-choice question and blocks "
    "until they answer (request_user_input / ask-user). Call it now with the "
    "question 'red or blue?' and the options red and blue. Call the tool; do not "
    "write the question as prose."
)


def run_turn_cell(home, req_base, start_params, prompt, timeout, capabilities=None):
    """Start one thread with `start_params`, drive `prompt`, report what arrived."""
    work = new_workspace()
    s = CodexSession(work, home)
    try:
        s.request(req_base, "initialize", {
            "clientInfo": {"name": "approval-probe", "title": "approval-probe", "version": "0"},
            "capabilities": capabilities})
        started = s.request(req_base + 1, "thread/start", dict(start_params, cwd=work))
        if not started or "result" not in started:
            return {"error": "thread/start failed", "response": started}
        result = started["result"]
        mark = len(s.server_requests)
        outcome, ev_mark = s.turn(req_base + 2, result["thread"]["id"], prompt, timeout=timeout)
        arrivals = s.requests_since(mark)
        return {
            "start_params": {k: v for k, v in start_params.items()},
            "reported_approval_policy": result.get("approvalPolicy"),
            "reported_sandbox": result.get("sandbox"),
            "turn_outcome": outcome,
            "server_request_methods": [r["method"] for r in arrivals],
            "approval_requests": [r for r in arrivals if r["method"] in APPROVAL_METHODS],
            "user_input_requests": [r for r in arrivals if r["method"] == USER_INPUT_METHOD],
            "file_after": Path(work, "notes.txt").read_text(),
            "agent_text": next(
                ((e.get("params", {}).get("item") or {}).get("text")
                 for e in s.events[ev_mark:]
                 if e.get("method") == "item/completed"
                 and (e.get("params", {}).get("item") or {}).get("type") == "agentMessage"),
                None),
            "tool_items": sorted({
                (e.get("params", {}).get("item") or {}).get("type")
                for e in s.events[ev_mark:]
                if e.get("method") == "item/completed"
            } - {None}),
        }
    finally:
        s.close()
        shutil.rmtree(work, ignore_errors=True)


def run_fork_cell(home, req_base, timeout, parent_params=None):
    """Fork a non-ephemeral parent started the way the adapter starts one, read the response."""
    work = new_workspace()
    s = CodexSession(work, home)
    try:
        s.request(req_base, "initialize", {
            "clientInfo": {"name": "approval-probe", "title": "approval-probe", "version": "0"}})
        # NOT ephemeral: thread/fork loads the parent from disk.
        params = dict(parent_params or {"sandbox": "danger-full-access"}, cwd=work)
        started = s.request(req_base + 1, "thread/start", params)
        if not started or "result" not in started:
            return {"error": "thread/start failed", "response": started}
        parent = started["result"]
        outcome, _ = s.turn(req_base + 2, parent["thread"]["id"],
                            "Reply with exactly: ok", timeout=timeout)
        forked = s.request(req_base + 3, "thread/fork",
                           {"threadId": parent["thread"]["id"], "cwd": work})
        out = {
            "parent_start_params": {k: v for k, v in params.items() if k != "cwd"},
            "parent_turn_outcome": outcome,
            "parent_reported_approval_policy": parent.get("approvalPolicy"),
            "parent_reported_sandbox": parent.get("sandbox"),
        }
        if forked and "result" in forked:
            fr = forked["result"]
            out["fork_reported_approval_policy"] = fr.get("approvalPolicy")
            out["fork_reported_sandbox"] = fr.get("sandbox")
            out["fork_thread_id_differs"] = fr["thread"]["id"] != parent["thread"]["id"]
        else:
            out["fork_error"] = forked
        # And the same fork with both policies passed explicitly, which is what
        # the adapter now does.
        forked2 = s.request(req_base + 4, "thread/fork",
                            {"threadId": parent["thread"]["id"], "cwd": work,
                             "sandbox": "danger-full-access", "approvalPolicy": "never"})
        if forked2 and "result" in forked2:
            out["explicit_fork_reported_approval_policy"] = forked2["result"].get("approvalPolicy")
            out["explicit_fork_reported_sandbox"] = forked2["result"].get("sandbox")
        else:
            out["explicit_fork_error"] = forked2
        return out
    finally:
        s.close()
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=120)
    args = ap.parse_args()

    home = Path(tempfile.mkdtemp(prefix="agentpane-approval-home-"))
    real = Path.home() / ".codex"
    for f in CODEX_STATE_FILES:
        if (real / f).exists():
            shutil.copy(real / f, home / f)

    record = {"codex_version": cli_version("codex")}
    try:
        record["a_default_no_policy"] = run_turn_cell(
            home, 100, {"sandbox": "danger-full-access", "ephemeral": True},
            EDIT_PROMPT, args.timeout)
        record["a_policy_never"] = run_turn_cell(
            home, 200,
            {"sandbox": "danger-full-access", "ephemeral": True, "approvalPolicy": "never"},
            EDIT_PROMPT, args.timeout)
        # A control that DOES provoke an approval: the write is outside the
        # sandbox's writable set, so `on-request` has to ask.
        record["a_control_readonly_no_policy"] = run_turn_cell(
            home, 500, {"sandbox": "read-only", "ephemeral": True},
            EDIT_PROMPT, args.timeout)
        record["a_readonly_policy_never"] = run_turn_cell(
            home, 600, {"sandbox": "read-only", "ephemeral": True, "approvalPolicy": "never"},
            EDIT_PROMPT, args.timeout)
        record["b_fork"] = run_fork_cell(home, 300, args.timeout)
        # Disambiguates inherit-vs-default: the parent's policy is not
        # app-server's default here, so an inheriting fork would report "never".
        record["b_fork_parent_never"] = run_fork_cell(
            home, 700, args.timeout,
            parent_params={"sandbox": "danger-full-access", "approvalPolicy": "never"})
        record["c_user_input_under_never"] = run_turn_cell(
            home, 400,
            {"sandbox": "danger-full-access", "ephemeral": True, "approvalPolicy": "never"},
            ASK_PROMPT, args.timeout)
        record["c_user_input_experimental_api"] = run_turn_cell(
            home, 800,
            {"sandbox": "danger-full-access", "ephemeral": True, "approvalPolicy": "never"},
            ASK_PROMPT2, args.timeout,
            capabilities={"experimentalApi": True, "requestAttestation": False})
        record["c_prompts"] = {"default": ASK_PROMPT, "experimental_api": ASK_PROMPT2}
    finally:
        shutil.rmtree(home, ignore_errors=True)

    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
