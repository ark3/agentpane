#!/usr/bin/env python3
"""Where does a prompt posted mid-turn land on Pi? (OW-yuyofu)

`docs/DESIGN.md` D16 says a prompt submitted while a turn is running joins
*that* turn, and that an adapter whose backend cannot do that rejects rather
than silently downgrading to a follow-up. Claude Code's rejection and Codex's
steer were both settled live; Pi's half rested on `submit()` in
`src/server/adapters/pi/process.ts` setting `streamingBehavior: "steer"` when
`this.state.isStreaming`, plus Pi's own `rpc.md` (which lives on the work
laptop -- see `docs/HANDOFF.md`, "Reference material on the work laptop"), and
on nothing anyone ran. A mid-turn POST returning **202** was separately observed, but a 202 that
steers into the running turn, a 202 that queues for a following turn, and a 202
that drops the text are three different products behind one status code.

This drives the real chain -- `direnv exec <workspace> sbox -- pi --mode rpc`,
spawned by agentpane's own built server, through the ordinary REST submit route
-- because the adapter's `submit()` path is the subject and only exists there.
Copied from `agentpane_pi_smoke.py` (spawn/build/attach/SSE/shutdown) rather
than added to it; the measurement's shape comes from `codex_turn_probe.py`'s
steer phase.

## Why it taps Pi's stdout

The discriminating evidence is Pi's own turn bookkeeping, and none of it
reaches agentpane's wire: `src/server/adapters/pi/reducer.ts` maps
`agent_start`/`agent_settled` to `isStreaming` and drops `turn_start`,
`turn_end`, `agent_end` and `queue_update` on the floor -- the first two as
redundant with the `message_*` pair, `agent_end` by falling through to
`default`, and `queue_update` as "session bookkeeping outside the
AgentMessage/isStreaming contract". `agent_settled` on
its own cannot settle the question either, because that same docblock records
that an `agent_end` may be followed by *queued continuations* -- so a follow-up
queue could drain without any `agent_settled` in between and look identical on
the SSE stream.

So the probe puts a `pi` shim first on the server's PATH that pipes the real
binary's stdout through `tee`. Stdin, stdout and stderr pass through untouched
and the tap file is a verbatim copy of every line Pi wrote. `queue_update` is
the load-bearing one: Pi names the queue it put the text in, `steering` or
`followUp`.

The one thing the shim does *not* pass through is Pi's exit status: `sh` reports
a pipeline's last stage, so the server sees `tee`'s status and never Pi's. That
costs this probe nothing -- it decides on positive evidence in the tap and never
reads the agent's exit code -- but a probe copied from this one that wants to
assert on how Pi exited has to take the status out of the pipeline first.

The tap preserves **order**, not time -- `tee` stamps nothing. Every duration
in the record is measured on the probe's side of the wire, from a stamp taken
immediately before the request that caused the event, which is the hazard
OW-hahohi recorded: an SSE arrival stamp minus another arrival stamp once came
out negative, because the first event was already buffered before the wait
began. Positions in the tap are pinned the same way -- the tap's line count is
read at the instant the mid-turn POST goes out, and the census below that cut
is the one that decides the verdict.

## The model flag

`AGENTS.md` pins the home server's Pi to one model and says the flag is the
whole of the constraint, because `~/.pi/agent/settings.json` is mutable and was
for one day unreadable. `agentpane_pi_smoke.py` sends no `--model` and gets away
with it only because that file happens to name the pinned model. This probe
passes it explicitly, through the create-session route's `model` field, which
reaches `buildPiSpawnCommand`'s `--model`: the long first turn's length is a
criterion here, so a run that silently answered on a different model would not
be measuring what it reports. The model that actually answered is read back off
the wire regardless, and it is the wire string -- carrying a provider prefix the
settings file's string does not -- that the write-up names.

This makes real model calls. It never invokes Codex or Claude, copies Pi
credentials by name without reading them, and scopes process inspection to the
server it started.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
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
    last_streaming,
    make_state_home,
    max_assistant_length,
    now,
    ref_path,
    start_server,
    streaming_value,
    wait_for_built_client,
)

REPO = Path(__file__).resolve().parents[2]
HOST = "127.0.0.1"
PORT = 44176
PI_STATE_FILES = ("auth.json", "models.json", "models-store.json", "settings.json", "trust.json")
PINNED_MODEL = "openrouter/deepseek/deepseek-v4.1-flash:high"

# A turn has to still be running when the second prompt lands or the run
# measures nothing. "Integers 1 through 10000" is the known trap: OW-hahohi
# measured that the model declines it and explains itself in under 500
# characters. An essay it has opinions about is complied with; the floors below
# are asserted from the evidence rather than assumed.
LONG_PROMPT = (
    "Do not use tools. Write a detailed guide to growing vegetables in a home garden. "
    "Cover each of these in its own titled section, and write at least 120 words in each "
    "section: soil preparation, watering, sunlight and siting, pest control, composting, "
    "crop rotation, harvesting, and planning across the seasons. Write the sections in that "
    "order and do not summarise at the end."
)
MIN_CHARS_BEFORE_STEER = 1200
MIN_UPSERTS_BEFORE_STEER = 25


def pi_workers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """This run's agent-side processes inside the sandbox.

    `agentpane_pi_smoke.py` explains why the match is on the program and not on
    argv: Pi sets `process.title`, so its own `/proc/<pid>/cmdline` is bare `pi`
    and the `bwrap` wrappers are the only processes still carrying
    `--mode rpc`. The `tee` of the stdout tap and the `sh` running the shim's
    pipeline are this probe's own additions to that tree and have to be reaped
    with it, or a "no orphans" result would be reading a smaller tree than the
    run created.
    """
    return [
        row
        for row in rows
        if row["comm"] in ("pi", "tee")
        or (row["comm"] in ("node", "sh") and "--mode rpc" in row["cmd"])
    ]


def make_shim(real_pi: Path, tap: Path) -> Path:
    """A `pi` that is the real `pi` with its stdout copied to `tap`.

    Lives under /tmp because that is mounted read-write inside sbox on the home
    server, and is found because the server's PATH names it first. `exec` in the
    first stage of a pipeline still forks a shell to wait on the pipeline, so
    the sandbox tree gains an `sh` and a `tee` alongside the agent; `pi_workers`
    above accounts for both.
    """
    shim_dir = Path(tempfile.mkdtemp(prefix="agentpane-pi-tap-", dir="/tmp"))
    script = shim_dir / "pi"
    script.write_text(f'#!/bin/sh\nexec "{real_pi}" "$@" | tee -a "{tap}"\n')
    script.chmod(0o755)
    return shim_dir


def tap_events(tap: Path) -> list[Any]:
    """Every line Pi has written to stdout so far, parsed where it is JSON."""
    if not tap.exists():
        return []
    out: list[Any] = []
    for line in tap.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            out.append({"type": "<unparsed>", "raw": line[:200]})
    return out


def message_text(message: Any) -> str:
    """Text of a Pi `AgentMessage`, whose `content` is a string or block list."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def timeline(events: list[Any], marker: str) -> list[dict[str, Any]]:
    """The structural events, in order, with the deltas counted rather than kept.

    `message_update` is thousands of lines of text deltas and says nothing about
    turn structure; everything else is retained, because "which events did Pi
    emit between the steer and its answer" is exactly the question and a
    filtered list would be the probe answering it in advance.
    """
    rows: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "message_update":
            continue
        row: dict[str, Any] = {"i": index, "type": kind}
        if kind == "queue_update":
            row["steering"] = event.get("steering")
            row["followUp"] = event.get("followUp")
        elif kind in ("message_start", "message_end"):
            message = event.get("message", {})
            text = message_text(message)
            row["role"] = message.get("role") if isinstance(message, dict) else None
            row["chars"] = len(text)
            row["has_marker"] = marker in text
        elif kind == "turn_end":
            message = event.get("message", {})
            text = message_text(message)
            row["role"] = message.get("role") if isinstance(message, dict) else None
            row["chars"] = len(text)
            row["has_marker"] = marker in text
        elif kind == "response":
            row["command"] = event.get("command")
            row["success"] = event.get("success")
        elif kind == "agent_end":
            row["willRetry"] = event.get("willRetry")
        rows.append(row)
    return rows


def census(events: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for event in events:
        kind = event.get("type") if isinstance(event, dict) else "<non-object>"
        counts[str(kind)] = counts.get(str(kind), 0) + 1
    return dict(sorted(counts.items()))


def classify(rows: list[dict[str, Any]], cut: int, marker: str) -> dict[str, Any]:
    """Which of D16's three the 202 was, read off Pi's own events.

    `cut` is the tap's line count read immediately before the mid-turn POST goes
    out, so everything considered here is strictly later in the tap than that
    pin. That is a hair earlier than the request itself, which is the safe
    direction: a stray line from the gap can only add to `agent_settled_between`
    and push the verdict toward `following_turn` or `indeterminate`, never
    toward a false steer.

    Two readings are taken, and they are **not** equals -- only the first tells
    steer from follow-up:

    * **Which queue Pi put it in.** `queue_update` carries `steering` and
      `followUp` arrays. Pi naming the queue is the whole discriminator: it is
      the only thing here that a follow-up would answer differently, which is
      why a run that does not produce one is `indeterminate` rather than a pass
      on the other reading.
    * **Whether the session left the turn in between.** The boundary is
      `agent_settled`, because that is the one Pi event agentpane turns into a
      turn boundary: `reducer.ts` maps `agent_settled`, and only
      `agent_settled`, to `isStreaming: false`, which is the session going idle
      on the wire and the turn ending as D16, the HTTP contract and the user all
      mean it. An answer with no `agent_settled` before it was answered without
      the session ever leaving the turn the prompt was posted into.
      This does **not** discriminate: the reducer's docblock records that an
      `agent_end` can be followed by queued continuations, so a `followUp` queue
      draining inside the same span would read identically. It is a necessary
      condition for D16 and not a sufficient one, and it is recorded as such.

    Deliberately *not* `agent_end`, and not Pi's own `turn_start`/`turn_end`,
    both of which are finer than an agentpane turn and neither of which
    survives as a discriminator:

    * `turn_start`/`turn_end` bound one LLM round. A steered message is drained
      into a round of its own, so even the cleanest steer shows two of them --
      the "same turn id throughout" reading that settled Codex under OW-tifuha
      has no Pi equivalent, and could not have one: `protocol.ts` types
      `turn_start` as `{ type: "turn_start" }`, carrying no id at all.
      This is not a boundary chosen after seeing which one gave the wanted
      answer. `resources/fixtures/pi/tool-read.jsonl` and `tool-edit.jsonl`,
      captured long before this probe existed, each hold **two**
      `turn_start`/`turn_end` pairs inside a single
      `agent_start`...`agent_settled` span, against one pair in `text.jsonl` --
      so an agentpane turn already demonstrably spanned several of Pi's, with
      no steer involved.
    * `agent_end` is the inner agent loop ending, and the reducer's own docblock
      says it "can be followed by retry/compaction/queued continuations" -- so
      it is not the turn ending. Measured on `pi 0.85.1`, whether one falls
      between the request and the answer is a **race** and came out both ways
      across two runs minutes apart: when the first reply was still generating
      as the steer was drained there was none, and when it had just finished
      Pi closed the loop and opened a fresh `agent_start` to drain the same
      `steering` queue. Neither run went through `agent_settled`. `agent_end`
      is therefore recorded here as `agent_end_between`, for the reader, and
      decides nothing.

    Returns `verdict: "indeterminate"` when the two disagree or when the queue
    reading -- the only discriminating one -- never fires -- a verdict this probe treats as a failed run, because a reader who
    cannot tell the three apart from the record is exactly what the card
    forbids.
    """
    after = [row for row in rows if row["i"] >= cut]

    queued_as = None
    queue_row = None
    for row in after:
        if row["type"] != "queue_update":
            continue
        in_steering = any(marker in str(text) for text in (row.get("steering") or []))
        in_follow_up = any(marker in str(text) for text in (row.get("followUp") or []))
        if in_steering or in_follow_up:
            queued_as = "steering" if in_steering else "followUp"
            queue_row = row
            break

    answer = None
    for row in after:
        if row["type"] == "message_end" and row.get("role") == "assistant" and row.get("has_marker"):
            answer = row
            break

    if answer is None:
        return {
            "verdict": "dropped",
            "queued_as": queued_as,
            "queue_update": queue_row,
            "answer": None,
            "agent_end_between": None,
            "agent_settled_between": None,
        }

    between = [row for row in after if row["i"] < answer["i"]]
    agent_ends = sum(1 for row in between if row["type"] == "agent_end")
    agent_settled = sum(1 for row in between if row["type"] == "agent_settled")

    by_boundary = "steered_into_running_turn" if agent_settled == 0 else "following_turn"
    by_queue = (
        None
        if queued_as is None
        else ("steered_into_running_turn" if queued_as == "steering" else "following_turn")
    )
    # `by_queue is None` is not a pass on `by_boundary` alone: that reading
    # cannot tell a steer from a drained follow-up, so with nothing to agree
    # with it the run has not answered the question.
    verdict = by_boundary if by_queue == by_boundary else "indeterminate"

    return {
        "verdict": verdict,
        "by_turn_boundary": by_boundary,
        "by_queue": by_queue,
        "queued_as": queued_as,
        "queue_update": queue_row,
        "answer": answer,
        "agent_end_between": agent_ends,
        "agent_settled_between": agent_settled,
        "events_between": between,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-root", type=Path, default=REPO)
    parser.add_argument("--workspace", type=Path, default=None)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--model",
        default=PINNED_MODEL,
        help="model ref passed to Pi's --model (default: the model AGENTS.md pins)",
    )
    parser.add_argument(
        "--credential-source",
        type=Path,
        default=Path.home() / ".pi" / "agent",
        help="directory containing Pi's auth/model state (contents are never printed)",
    )
    parser.add_argument("--skip-build", action="store_true", help="reuse an existing dist/client bundle")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = args.app_root.expanduser().resolve()
    workspace = (args.workspace or repo).expanduser().resolve()
    http = Http(HOST, args.port)
    marker = f"AGENTPANE-STEER-{uuid.uuid4().hex[:8].upper()}"

    real_pi = shutil.which("pi")
    if real_pi is None:
        raise SystemExit("pi is not on PATH")
    tap = Path(tempfile.mkstemp(prefix="agentpane-pi-tap-", suffix=".jsonl")[1])
    shim_dir = make_shim(Path(real_pi).resolve(), tap)

    state_home, copied = make_state_home(
        args.credential_source.expanduser().resolve(), PI_STATE_FILES, "agentpane-steer-pihome-"
    )
    server_log = Path(tempfile.mkstemp(prefix="agentpane-steer-server-", suffix=".log")[1])
    server: subprocess.Popen[bytes] | None = None
    streams: list[SseReader] = []
    launched_workers: set[int] = set()
    evidence: dict[str, Any] = {
        "started_at": now(),
        "backend": "pi",
        "probe": "agentpane_pi_steer_probe.py",
        "card": "OW-yuyofu",
        "workspace": str(workspace),
        "commit": subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True
        ).stdout.strip(),
        "pi_version": subprocess.run(
            [real_pi, "--version"], capture_output=True, text=True, check=True
        ).stdout.strip(),
        "model_flag": args.model,
        "marker": marker,
        "temporary_state_home": str(state_home),
        "copied_credential_files": copied,
        "checks": {},
    }
    exit_code = 1
    try:
        if "auth.json" not in copied:
            raise RuntimeError(f"missing Pi credentials under {args.credential_source}")
        if not args.skip_build:
            evidence["build"] = build_client(repo)

        server = start_server(
            repo,
            dict(
                os.environ,
                PATH=f"{shim_dir}{os.pathsep}{os.environ['PATH']}",
                PI_CODING_AGENT_DIR=str(state_home),
                PORT=str(args.port),
            ),
            server_log,
        )
        evidence["server_pid"] = server.pid
        wait_for_built_client(http, server, 20)

        stream = SseReader(HOST, args.port)
        stream.start()
        streams.append(stream)

        create_status, created = http.json(
            "POST",
            "/api/sessions",
            {"cwd": str(workspace), "backend": "pi", "model": args.model},
        )
        if create_status != 201:
            raise RuntimeError(f"create failed: HTTP {create_status} {created}")
        virtual_ref = created["ref"]
        attach_status, attached = http.json("GET", ref_path(virtual_ref))
        if attach_status != 200:
            raise RuntimeError(f"attach failed: HTTP {attach_status} {attached}")

        tree, workers = process_evidence(server.pid)
        launched_workers.update(row["pid"] for row in workers)
        chain = [row["comm"] for row in tree]
        if "bwrap" not in chain:
            raise RuntimeError(f"Pi was not spawned through the sandbox chain: {chain}")
        evidence["checks"]["startup"] = {
            "result": "pass",
            "http": [create_status, attach_status],
            "process_chain": chain,
            "process_tree": tree,
        }

        # D9: the id is the JSONL path and is adopted once Pi names the file.
        # Every `streaming`/`upsert` reading below is keyed on the adopted ref,
        # so resolve it before anything is measured.
        def renamed(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events:
                if event.get("type") == "renamed" and event.get("from") == virtual_ref:
                    return {"renamed_at": stamp, "to": event.get("session")}
            return None

        real_ref = stream.wait_for(renamed, 60, "Pi to adopt its own session id (D9)")["to"]
        evidence["session_id_is_jsonl_path"] = real_ref["id"].endswith(".jsonl")

        # -- 1. a turn long enough to steer into ---------------------------
        long_start = len(stream.snapshot())
        long_requested_at = now()
        long_status, long_body = http.json(
            "POST", ref_path(real_ref, "/prompt"), {"text": LONG_PROMPT}
        )
        if long_status != 202:
            raise RuntimeError(f"long prompt failed: HTTP {long_status} {long_body}")

        def long_enough(events: list[tuple[str, dict[str, Any]]]) -> Any:
            upserts = 0
            longest = 0
            for _, event in events[long_start:]:
                if event.get("session") != real_ref or event.get("type") != "upsert":
                    continue
                upserts += 1
                longest = max(longest, len(assistant_text(event.get("message", {}))))
            if upserts >= MIN_UPSERTS_BEFORE_STEER and longest >= MIN_CHARS_BEFORE_STEER:
                return {"upserts": upserts, "assistant_chars": longest}
            return None

        # The floor is asserted, not assumed: a model that declined the prompt
        # never reaches it and this times out rather than steering into a turn
        # that had already finished.
        reached = stream.wait_for(
            long_enough,
            180,
            f"the first turn to stream at least {MIN_CHARS_BEFORE_STEER} assistant characters",
        )
        evidence["checks"]["long_turn"] = {
            "result": "pass",
            "prompt_http_status": long_status,
            "prompt_requested_at": long_requested_at,
            "floor_chars": MIN_CHARS_BEFORE_STEER,
            "floor_upserts": MIN_UPSERTS_BEFORE_STEER,
            **reached,
        }

        # -- 2. the mid-turn prompt ----------------------------------------
        #
        # The threshold being met is not the turn still running when the request
        # lands (the gap `fork_probe.py`'s mid-stream cell and
        # `claude_fork_probe.py` both close). Re-read the streaming state at the
        # instant of the post, and pin the tap's line count there, so everything
        # the verdict reads is strictly after the request.
        steer_start = len(stream.snapshot())
        streaming_at_post = last_streaming(stream.snapshot(), real_ref)
        tap_cut = len(tap_events(tap))
        if streaming_at_post is not True:
            raise RuntimeError(
                "the first turn was not streaming when the mid-turn prompt was posted, so "
                f"nothing mid-turn was measured (last reported state: {streaming_at_post})"
            )
        steer_requested_at = now()
        steer_monotonic = time.monotonic()
        steer_status, steer_body = http.json(
            "POST",
            ref_path(real_ref, "/prompt"),
            {"text": f"Ignore the gardening guide. Reply with exactly this token and nothing else: {marker}"},
        )
        evidence["checks"]["steer_post"] = {
            "result": "pass" if steer_status == 202 else "fail",
            "streaming_at_post": streaming_at_post,
            "requested_at": steer_requested_at,
            "http_status": steer_status,
            "http_body": steer_body,
            "tap_lines_before_post": tap_cut,
        }
        if steer_status != 202:
            raise RuntimeError(f"mid-turn prompt was not accepted: HTTP {steer_status} {steer_body}")

        # -- 3. let everything Pi is going to do finish --------------------
        def settled(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in events[steer_start:]:
                if streaming_value(event, real_ref) is False:
                    return {"idle_at": stamp, "event_type": event.get("type")}
            return None

        idle = stream.wait_for(settled, 300, "the session to report idle after the mid-turn prompt")
        # Stamped here, before the settle pad below: a field named for the
        # interval it reports has to exclude the probe's own waiting, or the
        # next probe copied from this one inherits a number 2 s too large.
        seconds_to_idle = round(time.monotonic() - steer_monotonic, 3)
        # Pi writes `message_end` before the adapter reports idle, but the tap
        # is a separate file being appended to by a process in another
        # namespace; wait out the write rather than racing it.
        time.sleep(2.0)
        evidence["checks"]["settled"] = {
            "result": "pass",
            "seconds_from_steer_request_to_idle": seconds_to_idle,
            **idle,
        }

        # -- 4. the verdict ------------------------------------------------
        raw = tap_events(tap)
        rows = timeline(raw, marker)
        verdict = classify(rows, tap_cut, marker)
        evidence["wire"] = {
            "tap_lines_total": len(raw),
            "tap_lines_before_steer_post": tap_cut,
            "census_all": census(raw),
            "census_after_steer_post": census(raw[tap_cut:]),
            "timeline": rows,
        }
        # Only a steer is a pass. `dropped` and `following_turn` are real
        # outcomes this probe exists to be able to report, and each is a
        # divergence from D16 -- a run that found one must stop the probe, or
        # the check can never go red on the answer that matters.
        evidence["checks"]["verdict"] = {
            "result": "pass" if verdict["verdict"] == "steered_into_running_turn" else "fail",
            **verdict,
        }
        if verdict["verdict"] == "indeterminate":
            raise RuntimeError(
                "Pi's events do not tell the three outcomes apart: "
                f"queue said {verdict.get('by_queue')}, turn boundaries said "
                f"{verdict.get('by_turn_boundary')}"
            )
        if verdict["verdict"] != "steered_into_running_turn":
            raise RuntimeError(
                f"a prompt posted mid-turn was {verdict['verdict']} rather than steered "
                f"into the running turn, which D16 does not allow of the Pi adapter "
                f"(queued as {verdict.get('queued_as')!r})"
            )

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
            raise RuntimeError("no snapshot or status event named the model Pi resolved")
        evidence["checks"]["model"] = {"result": "pass", "flag_passed": args.model, **model_seen}
        evidence["final_max_assistant_chars"] = max_assistant_length(stream.snapshot(), real_ref)

        evidence["finished_at"] = now()
        evidence["result"] = "pass"
        exit_code = 0
    except Exception as error:
        evidence["finished_at"] = now()
        evidence["result"] = "fail"
        evidence["error"] = f"{type(error).__name__}: {error}"
        # The tap is removed below, so a run that died before the verdict would
        # otherwise leave nothing at all about what Pi emitted.
        evidence.setdefault("wire", {})["census_all"] = census(tap_events(tap))
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
        shutil.rmtree(shim_dir, ignore_errors=True)
        tap.unlink(missing_ok=True)

    print(json.dumps(evidence, indent=2))
    return exit_code


def process_evidence(server_pid: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tree = descendants(server_pid)
    return compact_tree(tree), pi_workers(tree)


if __name__ == "__main__":
    raise SystemExit(main())
