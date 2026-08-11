#!/usr/bin/env python3
"""One-shot live Pi smoke check through agentpane's production HTTP/SSE server.

The Codex counterpart proved the transport; this one exists for what is
different about Pi, and for the question the Codex run could only answer for
Codex.

Three things only this harness can establish:

* **The spawn chain.** Production builds `direnv exec <workspace> sbox -- pi
  --mode rpc` (D7). `capture_fixtures.py` deliberately does *not* go through
  sbox -- it spawns Pi directly, because it only needs the protocol -- so
  nothing had ever run Pi through the real wrapper chain.
* **The rename.** Pi's session id *is* its JSONL path (D9), and a `virtual`
  session has no path until its first prompt writes one. The id therefore
  changes under the client mid-conversation, which Codex never does. That is
  the contract most likely to be wrong, and it is only observable live.
* **Signal propagation.** DESIGN's third open question is settled for Codex
  and assumed for Pi. Killing the server has to reach an agent two `exec`s
  down inside `bwrap`, or every closed session leaks a live agent.

This makes real model calls. It never invokes Codex and never prints
credential contents; process inspection is scoped to this run's server tree by
`agentpane_live_support`, which owns that guarantee for both harnesses.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from agentpane_live_support import (
    Http,
    SseReader,
    assistant_text,
    build_client,
    compact_tree,
    descendants,
    finalize,
    growing_assistant_text,
    last_streaming,
    make_state_home,
    max_assistant_length,
    message_block_types,
    now,
    ref_path,
    start_server,
    streaming_value,
    wait_for_built_client,
)

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 44174
# Credentials plus the model catalogue and trust state -- the same set
# `capture_fixtures.py` copies, which is enough for a turn. Copied by name.
PI_STATE_FILES = ("auth.json", "models.json", "models-store.json", "settings.json", "trust.json")


def pi_workers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The Pi process itself, not the wrappers that carry its argv.

    The surviving `bwrap` processes have the whole `pi --mode rpc` command line
    in their own argv, so matching on argv alone counts one agent three times.
    Match on the program instead.

    Observed live rather than assumed, and neither guess survived. Pi is a
    `#!/usr/bin/env node` script, so its process ought to be `node` running a
    path -- instead it reports `comm=pi` with a command line of exactly `pi`.
    Setting `process.title` in Node overwrites the argv memory it is stored in,
    so the flags are gone from the agent's own `/proc/<pid>/cmdline`. The only
    processes here still carrying `--mode rpc` are the `bwrap` wrappers.

    So: identify by program, not by argv. The `node` spelling is kept as a
    fallback in case a future Pi drops the title, because a matcher that
    silently finds nothing reads exactly like "nothing leaked".
    """
    return [
        row
        for row in rows
        if row["comm"] == "pi" or (row["comm"] == "node" and "--mode rpc" in row["cmd"])
    ]


def process_evidence(server_pid: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tree = descendants(server_pid)
    return compact_tree(tree), pi_workers(tree)


def chain_of(tree: list[dict[str, Any]]) -> list[str]:
    """The wrapper programs seen between the server and the agent."""
    return [row["comm"] for row in tree]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app-root",
        type=Path,
        default=REPO,
        help="agentpane checkout to build and serve (default: derived from this script)",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=None,
        help="workspace for the new Pi session (default: app root)",
    )
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--credential-source",
        type=Path,
        default=Path.home() / ".pi" / "agent",
        help="directory containing Pi's auth/model state (contents are never printed)",
    )
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing dist/client bundle")
    parser.add_argument(
        "--tool-check",
        action="store_true",
        help=(
            "also prompt for a shell tool call and assert a toolCall block reaches the wire. "
            "Off by default because it is the most model-dependent criterion here -- the model "
            "has to choose to call a tool. Verified working; if Pi ever does block on an "
            "approval dialog the check times out and fails rather than hanging."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = args.app_root.expanduser().resolve()
    workspace = (args.workspace or repo).expanduser().resolve()
    port = args.port
    http = Http(HOST, port)

    state_home, copied = make_state_home(
        args.credential_source.expanduser().resolve(),
        PI_STATE_FILES,
        "agentpane-live-pihome-",
    )
    server_log = Path(tempfile.mkstemp(prefix="agentpane-live-server-", suffix=".log")[1])
    server: subprocess.Popen[bytes] | None = None
    streams: list[SseReader] = []
    launched_workers: set[int] = set()
    evidence: dict[str, Any] = {
        "started_at": now(),
        "backend": "pi",
        "workspace": str(workspace),
        "pi_version": subprocess.run(
            ["pi", "--version"], capture_output=True, text=True, check=True
        ).stdout.strip(),
        "transport_level": "built client reachability plus production REST/SSE; no browser automation",
        "temporary_state_home": str(state_home),
        "copied_credential_files": copied,
        "checks": {},
    }
    exit_code = 1
    try:
        if not repo.is_dir() or not (repo / "package.json").is_file():
            raise RuntimeError(f"not an agentpane checkout: {repo}")
        if not workspace.is_dir():
            raise RuntimeError(f"workspace does not exist: {workspace}")
        if "auth.json" not in copied:
            raise RuntimeError(f"missing Pi credentials under {args.credential_source}")

        if not args.skip_build:
            evidence["build"] = build_client(repo)

        server = start_server(
            repo,
            dict(os.environ, PI_CODING_AGENT_DIR=str(state_home), PORT=str(port)),
            server_log,
        )
        evidence["server_pid"] = server.pid

        static_status, static_body = wait_for_built_client(http, server, 20)
        evidence["built_client"] = {
            "timestamp": now(),
            "http_status": static_status,
            "has_app_mount": b'id="app"' in static_body,
        }

        stream = SseReader(HOST, port)
        stream.start()
        streams.append(stream)

        # -- 1. spawn through the real wrapper chain ------------------------
        create_status, created = http.json(
            "POST", "/api/sessions", {"cwd": str(workspace), "backend": "pi"}
        )
        if create_status != 201:
            raise RuntimeError(f"create failed: HTTP {create_status} {created}")
        virtual_ref = created["ref"]
        if not virtual_ref["id"].startswith("virtual:"):
            raise RuntimeError(f"a new Pi session should be virtual until prompted: {virtual_ref}")

        attach_status, attached = http.json("GET", ref_path(virtual_ref))
        if attach_status != 200:
            raise RuntimeError(f"attach failed: HTTP {attach_status} {attached}")
        attached_ref = attached["session"]["ref"]

        tree, workers = process_evidence(server.pid)
        launched_workers.update(row["pid"] for row in workers)
        evidence["initial_process_tree"] = tree
        evidence["initial_pi_candidates"] = [
            {"pid": row["pid"], "ppid": row["ppid"], "comm": row["comm"], "cmd": row["cmd"]}
            for row in workers
        ]
        if len(workers) != 1:
            # The whole tree, with command lines, because "found 0" is otherwise
            # indistinguishable between "nothing spawned" and "the matcher is wrong".
            evidence["unmatched_process_tree"] = descendants(server.pid)
            raise RuntimeError(f"expected one Pi descendant, found {len(workers)}")
        chain = chain_of(tree)
        if "bwrap" not in chain:
            raise RuntimeError(f"Pi was not spawned through the sandbox chain: {chain}")
        evidence["checks"]["startup"] = {
            "timestamp": now(),
            "result": "pass",
            "http": [create_status, attach_status],
            "still_virtual_after_attach": attached_ref["id"].startswith("virtual:"),
            "process_chain": chain,
            "process_tree": tree,
            "pi_worker_pids": sorted(launched_workers),
        }

        # -- 2. Pi names the session, and the id changes under the client ---
        #
        # D9 says a `virtual` session has no JSONL path until its first prompt
        # writes one, so this check was originally written to fire after the
        # prompt. Observed instead on pi 0.84.1: the session file exists by the
        # time `start()`'s `get_state` probe answers, so the rename lands during
        # *attach*. Both orderings are legitimate -- the adapter's contract is
        # that `ref` is unstable at two points, not that it changes at exactly
        # one -- so scan the whole stream and record which one actually happened.
        def renamed(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events:
                if event.get("type") == "renamed" and event.get("from") == virtual_ref:
                    return {"renamed_at": stamp, "to": event.get("session")}
            return None

        rename = stream.wait_for(renamed, 60, "the virtual id to be replaced by Pi's own (D9)")
        real_ref = rename["to"]
        if not isinstance(real_ref, dict) or real_ref.get("backend") != "pi":
            raise RuntimeError(f"renamed event carried no Pi ref: {rename}")
        if real_ref["id"].startswith("virtual:") or not real_ref["id"].endswith(".jsonl"):
            raise RuntimeError(f"Pi did not adopt a JSONL path as its id: {real_ref}")

        # The browser that created the session is still holding the old id and
        # may already have a prompt in flight against it, so it has to keep
        # working -- this is the difference between "the second message in a new
        # conversation works" and a 404.
        alias_status, aliased = http.json("GET", ref_path(virtual_ref))
        if alias_status != 200:
            raise RuntimeError(f"the superseded id stopped resolving: HTTP {alias_status} {aliased}")
        evidence["checks"]["rename"] = {
            "result": "pass",
            "renamed_at": rename["renamed_at"],
            "renamed_during": "attach" if not attached_ref["id"].startswith("virtual:") else "first prompt",
            "adopted_id_is_jsonl_path": True,
            "superseded_id_still_resolves": alias_status == 200,
            "superseded_id_resolves_to_new_ref": aliased["session"]["ref"] == real_ref,
        }

        # -- 3. streaming transcript, prompted through the superseded id ----
        first_start = len(stream.snapshot())
        prompt_status, prompt_body = http.json(
            "POST",
            ref_path(virtual_ref, "/prompt"),
            {"text": "Do not use tools. Reply with two or three sentences about why deterministic tests are useful."},
        )
        if prompt_status != 202:
            raise RuntimeError(f"prompt failed: HTTP {prompt_status} {prompt_body}")
        evidence["checks"]["rename"]["prompt_via_superseded_id_http_status"] = prompt_status
        growth = stream.wait_for(
            lambda events: growing_assistant_text(events, real_ref, first_start),
            120,
            "incremental assistant transcript updates",
        )

        def idle_after_streaming(events: list[tuple[str, dict[str, Any]]]) -> Any:
            saw_true = False
            true_at = None
            for stamp, event in events[first_start:]:
                value = streaming_value(event, real_ref)
                if value is True:
                    saw_true = True
                    true_at = stamp
                if saw_true and value is False:
                    return {
                        "streaming_at": true_at,
                        "idle_at": stamp,
                        "idle_event_type": event.get("type"),
                    }
            return None

        idle = stream.wait_for(idle_after_streaming, 180, "streaming state to return to idle")
        evidence["checks"]["text_stream"] = {"result": "pass", **growth}
        evidence["checks"]["idle"] = {"result": "pass", **idle}

        # Any blocking request Pi raised is worth recording either way: whether
        # these fire at all under the sandbox is an open question (D2a).
        evidence["agent_requests_seen"] = [
            {"at": stamp, "kind": event.get("request", {}).get("kind")}
            for stamp, event in stream.snapshot()
            if event.get("type") == "request"
        ]

        if args.tool_check:
            tool_start = len(stream.snapshot())
            tool_status, tool_body = http.json(
                "POST",
                ref_path(real_ref, "/prompt"),
                {"text": "Run the shell command `echo agentpane-live-probe` and report its output."},
            )
            if tool_status != 202:
                raise RuntimeError(f"tool prompt failed: HTTP {tool_status} {tool_body}")

            def tool_called(events: list[tuple[str, dict[str, Any]]]) -> Any:
                for stamp, event in events[tool_start:]:
                    if event.get("session") != real_ref:
                        continue
                    messages = (
                        [event.get("message", {})]
                        if event.get("type") == "upsert"
                        else event.get("messages", [])
                    )
                    for message in messages:
                        if "toolCall" in message_block_types(message):
                            return {"at": stamp, "blocks": message_block_types(message)}
                return None

            tool = stream.wait_for(tool_called, 180, "a toolCall block to reach the wire")
            evidence["checks"]["tool_output"] = {"result": "pass", **tool}

        # -- 4. abort, then shutdown without an orphan ---------------------
        abort_start = len(stream.snapshot())
        long_status, long_body = http.json(
            "POST",
            ref_path(real_ref, "/prompt"),
            {"text": "Do not use tools. Write the integers from 1 through 10000, one per line, and continue until every integer is written."},
        )
        if long_status != 202:
            raise RuntimeError(f"long prompt failed: HTTP {long_status} {long_body}")

        def active(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[abort_start:]:
                if streaming_value(event, real_ref) is True:
                    return stamp
            return None

        active_at = stream.wait_for(active, 90, "long turn streaming=true")
        time.sleep(0.35)

        # The cut is pinned immediately before the request, so a turn that ended
        # on its own cannot stand in for the abort. See the Codex harness for
        # the full argument, including the hole this narrows rather than closes.
        pre_abort = stream.snapshot()
        abort_index = len(pre_abort)
        pre_abort_streaming = last_streaming(pre_abort, real_ref)
        if pre_abort_streaming is not True:
            raise RuntimeError(
                "long turn was not streaming when the abort was issued "
                f"(last reported state: {pre_abort_streaming})"
            )

        abort_requested_at = now()
        abort_status, abort_body = http.json("POST", ref_path(real_ref, "/abort"))
        if abort_status != 204:
            raise RuntimeError(f"abort failed: HTTP {abort_status} {abort_body}")

        def aborted_idle(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[abort_index:]:
                if streaming_value(event, real_ref) is False:
                    return {"timestamp": stamp, "event_type": event.get("type")}
            return None

        aborted = stream.wait_for(aborted_idle, 90, "aborted turn streaming=false")
        settled_length = max_assistant_length(stream.snapshot(), real_ref)
        time.sleep(1.5)
        after_length = max_assistant_length(stream.snapshot(), real_ref)
        if after_length != settled_length:
            raise RuntimeError(
                f"transcript kept growing after the abort reported idle: {settled_length} -> {after_length}"
            )
        evidence["checks"]["abort"] = {
            "result": "pass",
            "prompt_http_status": long_status,
            "streaming_at": active_at,
            "streaming_at_abort": pre_abort_streaming,
            "abort_requested_at": abort_requested_at,
            "abort_http_status": abort_status,
            "idle_at": aborted["timestamp"],
            "idle_event_type": aborted["event_type"],
            "assistant_length_when_idle": settled_length,
            "assistant_length_after_settling": after_length,
        }

        # This is DESIGN's third open question for Pi: the agent is two `exec`s
        # down inside `bwrap`, and nothing else will ever reap it.
        before_shutdown, shutdown_workers = process_evidence(server.pid)
        launched_workers.update(row["pid"] for row in shutdown_workers)
        evidence["shutdown_requested_at"] = now()
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=30)
        evidence["server_exit"] = {"timestamp": now(), "returncode": server.returncode}
        deadline = time.monotonic() + 10
        remaining = sorted(pid for pid in launched_workers if Path(f"/proc/{pid}").exists())
        while remaining and time.monotonic() < deadline:
            time.sleep(0.1)
            remaining = sorted(pid for pid in launched_workers if Path(f"/proc/{pid}").exists())
        evidence["checks"]["shutdown"] = {
            "result": "pass" if not remaining else "fail",
            "process_tree_before_shutdown": before_shutdown,
            "launched_pi_worker_pids": sorted(launched_workers),
            "remaining_worker_pids": remaining,
        }
        if remaining:
            raise RuntimeError(f"run-scoped Pi workers remained after shutdown: {remaining}")

        evidence["finished_at"] = now()
        evidence["result"] = "pass"
        exit_code = 0
    except Exception as error:
        evidence["finished_at"] = now()
        evidence["result"] = "fail"
        evidence["error"] = f"{type(error).__name__}: {error}"
        if server_log.exists():
            evidence["server_log_tail"] = server_log.read_text(errors="replace")[-4000:]
        exit_code = 1
    finally:
        exit_code = finalize(
            evidence,
            exit_code,
            server=server,
            streams=streams,
            state_home=state_home,
            server_log=server_log,
            launched_workers=launched_workers,
            worker_filter=pi_workers,
        )

    print(json.dumps(evidence, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
