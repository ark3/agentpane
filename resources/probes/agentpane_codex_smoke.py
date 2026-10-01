#!/usr/bin/env python3
"""One-shot live Codex smoke check through agentpane's production HTTP/SSE server.

This makes real model calls. It never invokes Pi and never prints credential
contents. Process inspection is scoped to the server tree this run launched --
see `agentpane_live_support`, which owns that guarantee for both harnesses.

The session is created with an explicit `model`, defaulting to the one
`AGENTS.md` pins, because nothing else would choose it: agentpane spawns a bare
`codex app-server` (`codexCommand`) and sends no model on `thread/start` unless
the session was created with one, so Codex would answer on whatever the
`config.toml` copied into the throwaway `CODEX_HOME` names. The model the thread
reported is read back off the wire and recorded beside the flag (OW-yehisa).
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
    LONG_PROMPT,
    Http,
    SseReader,
    assistant_chars,
    assistant_text,
    build_client,
    compact_tree,
    descendants,
    finalize,
    growing_assistant_text,
    last_streaming,
    make_state_home,
    max_assistant_length,
    now,
    ref_path,
    start_server,
    streaming_value,
    turn_messages,
    wait_for_built_client,
    wait_for_turn_to_fill,
)

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 44173
# Credentials plus the config Codex needs to reach a model. Copied by name.
CODEX_STATE_FILES = ("auth.json", "config.toml")
PINNED_MODEL = "gpt-5.6-luna"


def codex_workers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The npm launcher is a Node process whose argv also says `app-server`;
    # it starts one native binary named `codex`. Count that leaf worker while
    # retaining the complete launcher tree separately as evidence.
    return [row for row in rows if row["comm"] == "codex" and "app-server" in row["cmd"]]


def process_evidence(server_pid: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tree = descendants(server_pid)
    return compact_tree(tree), codex_workers(tree)


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
        help="workspace for the new Codex session (default: app root)",
    )
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--model",
        default=PINNED_MODEL,
        help="model passed on the create-session route (default: the model AGENTS.md pins)",
    )
    parser.add_argument(
        "--credential-source",
        type=Path,
        default=Path.home() / ".codex",
        help="directory containing auth.json/config.toml (contents are never printed)",
    )
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing dist/client bundle")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = args.app_root.expanduser().resolve()
    workspace = (args.workspace or repo).expanduser().resolve()
    port = args.port
    http = Http(HOST, port)

    state_home, copied = make_state_home(
        args.credential_source.expanduser().resolve(),
        CODEX_STATE_FILES,
        "agentpane-live-codexhome-",
    )
    server_log = Path(tempfile.mkstemp(prefix="agentpane-live-server-", suffix=".log")[1])
    server: subprocess.Popen[bytes] | None = None
    streams: list[SseReader] = []
    launched_workers: set[int] = set()
    evidence: dict[str, Any] = {
        "started_at": now(),
        "backend": "codex",
        "workspace": str(workspace),
        "codex_version": subprocess.run(
            ["codex", "--version"], capture_output=True, text=True, check=True
        ).stdout.strip(),
        "model_flag": args.model,
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
            raise RuntimeError(f"missing Codex credentials under {args.credential_source}")

        if not args.skip_build:
            evidence["build"] = build_client(repo)

        server = start_server(
            repo, dict(os.environ, CODEX_HOME=str(state_home), PORT=str(port)), server_log
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

        create_status, created = http.json(
            "POST", "/api/sessions", {"cwd": str(workspace), "backend": "codex", "model": args.model}
        )
        if create_status != 201:
            raise RuntimeError(f"create failed: HTTP {create_status} {created}")
        virtual_ref = created["ref"]

        attach_status, attached = http.json("GET", ref_path(virtual_ref))
        if attach_status != 200:
            raise RuntimeError(f"attach failed: HTTP {attach_status} {attached}")
        real_ref = attached["session"]["ref"]
        if real_ref["backend"] != "codex" or real_ref["id"].startswith("virtual:"):
            raise RuntimeError(f"attach did not adopt a Codex thread id: {real_ref}")

        tree, workers = process_evidence(server.pid)
        evidence["initial_process_tree"] = tree
        evidence["initial_app_server_candidates"] = [
            {"pid": row["pid"], "ppid": row["ppid"], "comm": row["comm"], "cmd": row["cmd"]}
            for row in workers
        ]
        launched_workers.update(row["pid"] for row in workers)
        if len(workers) != 1:
            raise RuntimeError(f"expected one Codex app-server descendant, found {len(workers)}")
        evidence["checks"]["create"] = {
            "timestamp": now(),
            "result": "pass",
            "http": [create_status, attach_status],
            "virtual_id_adopted": True,
            "process_tree": tree,
            "codex_worker_pids": sorted(launched_workers),
        }

        first_start = len(stream.snapshot())
        prompt_status, prompt_body = http.json(
            "POST",
            ref_path(real_ref, "/prompt"),
            {
                "text": "Do not use tools. Write one sentence of at least 120 words explaining why deterministic tests are useful."
            },
        )
        if prompt_status != 202:
            raise RuntimeError(f"prompt failed: HTTP {prompt_status} {prompt_body}")

        growth = stream.wait_for(
            lambda events: growing_assistant_text(events, real_ref, first_start),
            90,
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
        evidence["checks"]["text_stream"] = {
            "timestamp": now(),
            "result": "pass",
            "prompt_http_status": prompt_status,
            **growth,
        }
        evidence["checks"]["idle"] = {"result": "pass", **idle}

        # Which model the thread reported, off the latest `snapshot` or `status`
        # the settled turn left on the wire: the adapter fills it from the
        # `thread/start` answer (`CodexAdapter.start`), so it is Codex's word,
        # not an echo of the flag.
        def resolved_model(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in reversed(events):
                if event.get("session") != real_ref:
                    continue
                if event.get("type") not in ("snapshot", "status"):
                    continue
                model = event.get("model")
                if isinstance(model, str) and model:
                    return {"at": stamp, "model": model, "event_type": event.get("type")}
            return None

        model_seen = resolved_model(stream.snapshot())
        if model_seen is None:
            raise RuntimeError("no settled snapshot or status event named the model Codex resolved")
        evidence["checks"]["model"] = {"result": "pass", "flag_passed": args.model, **model_seen}

        final_length = max_assistant_length(stream.snapshot(), real_ref)
        before_tree, before_workers = process_evidence(server.pid)
        stream.close()

        reconnect = SseReader(HOST, port)
        reconnect.start()
        streams.append(reconnect)

        def repainted(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events:
                if event.get("type") != "snapshot" or event.get("session") != real_ref:
                    continue
                lengths = [
                    len(assistant_text(message))
                    for message in event.get("messages", [])
                    if assistant_text(message)
                ]
                if lengths and max(lengths) >= final_length:
                    return {
                        "snapshot_at": stamp,
                        "message_count": len(event.get("messages", [])),
                        "assistant_text_length": max(lengths),
                    }
            return None

        repaint = reconnect.wait_for(repainted, 20, "reconnect snapshot repaint")
        after_tree, after_workers = process_evidence(server.pid)
        launched_workers.update(row["pid"] for row in after_workers)
        before_pids = sorted(row["pid"] for row in before_workers)
        after_pids = sorted(row["pid"] for row in after_workers)
        if before_pids != after_pids or len(after_pids) != 1:
            raise RuntimeError(
                f"Codex worker changed across reconnect: before={before_pids}, after={after_pids}"
            )
        evidence["checks"]["reconnect"] = {
            "result": "pass",
            **repaint,
            "codex_worker_pids_before": before_pids,
            "codex_worker_pids_after": after_pids,
            "process_tree_before": before_tree,
            "process_tree_after": after_tree,
        }

        # The aborted turn's messages are read as every position past the
        # transcript's length at this cut (`turn_messages`), which holds only
        # if no earlier turn is still writing: the first turn reported idle
        # above and nothing has been prompted since.
        abort_start = len(reconnect.snapshot())
        long_status, long_body = http.json(
            "POST", ref_path(real_ref, "/prompt"), {"text": LONG_PROMPT}
        )
        if long_status != 202:
            raise RuntimeError(f"long prompt failed: HTTP {long_status} {long_body}")

        def active(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[abort_start:]:
                if streaming_value(event, real_ref) is True:
                    return stamp
            return None

        active_at = reconnect.wait_for(active, 60, "long turn streaming=true")

        # Let the turn's own text build up before cutting it, so the abort
        # tears down a large in-flight transcript rather than its first
        # sentence (`wait_for_turn_to_fill`, OW-sofige).
        abort_wait = wait_for_turn_to_fill(reconnect, real_ref, abort_start)

        # Everything the abort is judged on has to arrive after this point.
        # Scanning from the prompt instead lets a turn that ended on its own --
        # or an idle event left over from the reconnect -- stand in for the
        # abort, and that is a pass the check cannot tell from a real one. So:
        # pin the cut, require the turn to be streaming right up to it, and
        # accept only an idle that arrives past it.
        #
        # The cut is taken immediately before the request, not after it, so a
        # turn that ends of its own accord during the abort's round trip still
        # satisfies this. That hole is narrow rather than closed; closing it
        # needs a causal signal from the backend, which the SSE stream does not
        # carry.
        pre_abort = reconnect.snapshot()
        abort_index = len(pre_abort)
        pre_abort_streaming = last_streaming(pre_abort, real_ref)
        turn_at_abort = turn_messages(pre_abort, real_ref, abort_start)
        if pre_abort_streaming is not True:
            raise RuntimeError(
                "long turn was not streaming when the abort was issued "
                f"(last reported state: {pre_abort_streaming}; the turn held "
                f"{assistant_chars(turn_at_abort)} assistant characters)"
            )
        length_at_abort = assistant_chars(turn_at_abort)

        abort_requested_at = now()
        abort_status, abort_body = http.json("POST", ref_path(real_ref, "/abort"))
        if abort_status != 204:
            raise RuntimeError(f"abort failed: HTTP {abort_status} {abort_body}")

        def aborted_idle(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[abort_index:]:
                if streaming_value(event, real_ref) is False:
                    return {"timestamp": stamp, "event_type": event.get("type")}
            return None

        aborted_idle_event = reconnect.wait_for(aborted_idle, 60, "aborted turn streaming=false")

        # Idle is a claim about the turn; the transcript is what proves it. A
        # turn that keeps emitting text after reporting idle was not aborted.
        # Compared position by position, not as a total: a message that grows,
        # shrinks or appears after idle all change it.
        turn_when_idle = turn_messages(reconnect.snapshot(), real_ref, abort_start)
        time.sleep(1.5)
        turn_after = turn_messages(reconnect.snapshot(), real_ref, abort_start)
        if turn_after != turn_when_idle:
            raise RuntimeError(
                f"the aborted turn changed after it reported idle: {turn_when_idle} -> {turn_after}"
            )
        evidence["checks"]["abort"] = {
            "result": "pass",
            "prompt_http_status": long_status,
            "streaming_at": active_at,
            "abort_wait": abort_wait,
            "streaming_at_abort": pre_abort_streaming,
            "events_before_abort": abort_index,
            "abort_requested_at": abort_requested_at,
            "abort_http_status": abort_status,
            "idle_at": aborted_idle_event["timestamp"],
            "idle_event_type": aborted_idle_event["event_type"],
            "assistant_length_at_abort": length_at_abort,
            "assistant_length_when_idle": assistant_chars(turn_when_idle),
            "assistant_length_after_settling": assistant_chars(turn_after),
            "turn_messages_when_idle": turn_when_idle,
        }

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
            "launched_codex_worker_pids": sorted(launched_workers),
            "remaining_worker_pids": remaining,
        }
        if remaining:
            raise RuntimeError(f"run-scoped Codex workers remained after shutdown: {remaining}")

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
            worker_filter=codex_workers,
        )

    print(json.dumps(evidence, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
