#!/usr/bin/env python3
"""Which history loads draw Codex's full-history deprecation, and does paging replace them? (OW-kelene)

As of `codex-cli` 0.156.0 a Codex session in agentpane showed a
`deprecationNotice` reading "Full-history hydration is deprecated for paginated
threads".  This probe asks, of the CLI directly with no agentpane in the
picture:

  1. Which calls draw that notice, and how it arrives on the wire.  Every call
     under test runs in a FRESH app-server, so a notice sent once per process
     could not hide behind an earlier call; a final pair of calls in one
     process then shows whether it repeats.
  2. Which `historyMode` a thread `thread/start` creates, and which the
     copied-in rollouts read as.
  3. Whether `thread/turns/list` and `thread/items/list` answer for both modes,
     and whether the turns they page out -- at each `itemsView` -- carry the
     same turn ids and items as full-history hydration of the same thread.

It builds, in a temp CODEX_HOME, one fresh thread with two tiny turns on
`gpt-5.6-luna` (the second runs one shell command, so a tool item is in the
comparison), and copies in any rollouts named with `--rollout` from the real
store, read-only.

Usage:  python3 codex_history_paging_probe.py [--rollout PATH ...] [--json PATH]
Needs:  `codex` on PATH and readable auth under `~/.codex`.
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
from typing import Any

from codex_fork_same_process_probe import CLIENT_INFO, MODEL, AppServer, run_turn

# Notifications every fresh app-server sends on its own; not what a call drew.
BACKGROUND = {
    "account/rateLimits/updated",
    "mcpServer/startupStatus/updated",
    "remoteControl/status/changed",
    "skills/changed",
}
SETTLE_SECONDS = 2.0


def fresh(workspace: str, env: dict[str, str], label: str) -> AppServer:
    server = AppServer(workspace, env, label)
    response = server.call("initialize", {"clientInfo": CLIENT_INFO, "capabilities": None})
    if "error" in response:
        raise SystemExit(f"{label}: initialize failed: {response['error']}")
    time.sleep(SETTLE_SECONDS)
    return server


def drawn(server: AppServer, since: int) -> list[dict[str, Any]]:
    """What notifications the calls since `since` drew, background noise dropped."""
    time.sleep(SETTLE_SECONDS)
    with server.lock:
        events = server.notifications[since:]
    return [
        {"method": e.get("method"), "params": e.get("params")}
        for e in events
        if e.get("method") not in BACKGROUND and not str(e.get("method", "")).startswith("thread/status")
    ]


def summary(response: dict[str, Any]) -> dict[str, Any]:
    if "error" in response:
        return {"ok": False, "error": str(response["error"])[:300]}
    result = response.get("result", {})
    thread = result.get("thread") if isinstance(result, dict) else None
    out: dict[str, Any] = {"ok": True}
    if isinstance(thread, dict):
        out["historyMode"] = thread.get("historyMode")
        out["turns"] = len(thread.get("turns") or [])
        out["thread_id"] = thread.get("id")
    if isinstance(result, dict):
        for key in ("turnsBackwardsCursor", "itemsBackwardsCursor", "nextCursor", "backwardsCursor"):
            if key in result:
                out[key] = result[key]
        if isinstance(result.get("data"), list):
            out["data"] = len(result["data"])
    return out


def one_call(workspace: str, env: dict[str, str], method: str, params: dict[str, Any]) -> dict[str, Any]:
    server = fresh(workspace, env, method)
    try:
        mark = server.mark()
        response = server.call(method, params)
        return {"method": method, "params": params, "response": summary(response), "drew": drawn(server, mark)}
    finally:
        server.close()


def all_turns(server: AppServer, thread_id: str, items_view: str) -> dict[str, Any]:
    turns: list[dict[str, Any]] = []
    cursor = None
    pages = 0
    while True:
        params: dict[str, Any] = {"threadId": thread_id, "sortDirection": "asc", "itemsView": items_view, "limit": 2}
        if cursor:
            params["cursor"] = cursor
        response = server.call("thread/turns/list", params)
        if "error" in response:
            return {"error": str(response["error"])[:300]}
        pages += 1
        turns.extend(response["result"]["data"])
        cursor = response["result"].get("nextCursor")
        if not cursor or pages > 100:
            return {"turns": turns, "pages": pages}


def all_items(server: AppServer, thread_id: str) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    cursor = None
    pages = 0
    while True:
        params: dict[str, Any] = {"threadId": thread_id, "limit": 50}
        if cursor:
            params["cursor"] = cursor
        response = server.call("thread/items/list", params)
        if "error" in response:
            return {"error": str(response["error"])[:300]}
        pages += 1
        entries.extend(response["result"]["data"])
        cursor = response["result"].get("nextCursor")
        if not cursor or pages > 1000:
            return {"entries": entries, "pages": pages}


def compare(reference: list[dict[str, Any]], candidate: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn ids in order, and whether each turn's items match the reference's."""
    ref_ids = [t["id"] for t in reference]
    cand_ids = [t["id"] for t in candidate]
    mismatched = []
    for ref, cand in zip(reference, candidate):
        if ref.get("items") != cand.get("items"):
            mismatched.append(
                {
                    "turn": ref["id"],
                    "reference_items": [i.get("type") for i in ref.get("items", [])],
                    "candidate_items": [i.get("type") for i in cand.get("items", [])],
                    "candidate_itemsView": cand.get("itemsView"),
                }
            )
    return {
        "same_turn_ids": ref_ids == cand_ids,
        "turns": [len(ref_ids), len(cand_ids)],
        "same_items": not mismatched and ref_ids == cand_ids,
        "mismatched": mismatched[:5],
        "other_fields_differ": sorted(
            {
                key
                for ref, cand in zip(reference, candidate)
                for key in set(ref) | set(cand)
                if key != "items" and ref.get(key) != cand.get(key)
            }
        ),
    }


def examine(workspace: str, env: dict[str, str], thread_id: str) -> dict[str, Any]:
    out: dict[str, Any] = {"thread_id": thread_id, "calls": []}
    for method, params in (
        ("thread/read", {"threadId": thread_id}),
        ("thread/read", {"threadId": thread_id, "includeTurns": False}),
        ("thread/read", {"threadId": thread_id, "includeTurns": True}),
        ("thread/turns/list", {"threadId": thread_id, "itemsView": "full"}),
        ("thread/items/list", {"threadId": thread_id}),
        ("thread/resume", {"threadId": thread_id, "cwd": workspace}),
        ("thread/resume", {"threadId": thread_id, "cwd": workspace, "excludeTurns": True}),
        ("thread/fork", {"threadId": thread_id, "cwd": workspace}),
        ("thread/fork", {"threadId": thread_id, "cwd": workspace, "excludeTurns": True}),
    ):
        out["calls"].append(one_call(workspace, env, method, params))

    # The same process twice: does the notice repeat, or is it once per process?
    server = fresh(workspace, env, "repeat")
    try:
        mark = server.mark()
        server.call("thread/read", {"threadId": thread_id, "includeTurns": True})
        server.call("thread/read", {"threadId": thread_id, "includeTurns": True})
        out["repeat_in_one_process"] = [e["method"] for e in drawn(server, mark)]
    finally:
        server.close()

    # The replacement sequence agentpane would make: metadata-only resume, then
    # page everything, in one process -- and the comparison against full hydration.
    server = fresh(workspace, env, "paged")
    try:
        mark = server.mark()
        full = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})
        reference = full.get("result", {}).get("thread", {}).get("turns", [])
        after_full = server.mark()
        resumed = server.call("thread/resume", {"threadId": thread_id, "cwd": workspace, "excludeTurns": True})
        out["paged_resume"] = summary(resumed)
        views = {}
        for view in ("notLoaded", "summary", "full"):
            paged = all_turns(server, thread_id, view)
            views[view] = (
                paged
                if "error" in paged
                else {"pages": paged["pages"], **compare(reference, paged["turns"])}
            )
        out["turns_list_vs_full_hydration"] = views
        items = all_items(server, thread_id)
        if "error" in items:
            out["items_list_vs_full_hydration"] = items
        else:
            regrouped: dict[str, list[dict[str, Any]]] = {}
            for entry in items["entries"]:
                regrouped.setdefault(entry["turnId"], []).append(entry["item"])
            rebuilt = [{"id": turn_id, "items": turn_items} for turn_id, turn_items in regrouped.items()]
            stripped = [{"id": t["id"], "items": t.get("items", [])} for t in reference]
            out["items_list_vs_full_hydration"] = {"pages": items["pages"], **compare(stripped, rebuilt)}
        out["paged_sequence_drew"] = [e["method"] for e in drawn(server, after_full)]
        out["full_read_drew"] = [
            e["method"] for e in server.notifications[mark:after_full] if e.get("method") not in BACKGROUND
        ]
    finally:
        server.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rollout", type=Path, action="append", default=[], help="a stored rollout to copy in and examine")
    ap.add_argument("--json", type=Path, help="write the report here as well as to stdout")
    args = ap.parse_args()

    codex_home = Path(tempfile.mkdtemp(prefix="agentpane-pagingprobe-codexhome-"))
    for name in ("auth.json", "config.toml"):
        source = Path.home() / ".codex" / name
        if source.exists():
            shutil.copy2(source, codex_home / name)
    copied: list[str] = []
    for rollout in args.rollout:
        source = rollout.resolve()
        relative = source.relative_to((Path.home() / ".codex" / "sessions").resolve())
        target = codex_home / "sessions" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(json.loads(source.read_text().splitlines()[0])["payload"]["id"])
    workspace = tempfile.mkdtemp(prefix="agentpane-pagingprobe-work-")
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=False)
    env = dict(os.environ, CODEX_HOME=str(codex_home))

    report: dict[str, Any] = {
        "question": "which history loads draw the full-history deprecation, and does paging replace them (OW-kelene)",
        "codex_version": subprocess.run(["codex", "--version"], capture_output=True, text=True).stdout.strip(),
        "model": MODEL,
    }
    try:
        owner = fresh(workspace, env, "owner")
        try:
            started = owner.call("thread/start", {"cwd": workspace, "model": MODEL})
            report["thread_start"] = summary(started)
            fresh_id = started["result"]["thread"]["id"]
            report["turns"] = [
                run_turn(owner, fresh_id, "Reply with exactly: one"),
                run_turn(owner, fresh_id, "Run the shell command `echo two` once, then reply with exactly its output."),
            ]
        finally:
            owner.close()
        report["fresh"] = examine(workspace, env, fresh_id)
        report["copied"] = [examine(workspace, env, thread_id) for thread_id in copied]
    finally:
        shutil.rmtree(codex_home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)

    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        args.json.write_text(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
