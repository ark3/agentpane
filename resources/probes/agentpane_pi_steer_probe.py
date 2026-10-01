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

## The tool turn (`--turn tool`, OW-nufitu)

The text turn above never calls a tool, so it says nothing about the case Pi's
own `rpc-commands.md` describes `"steer"` by: the text "is delivered after the
current assistant turn finishes executing its tool calls, before the next LLM
call" (`pi 0.87.1`'s copy). `--turn tool` replaces the essay with a prompt
asking for three `bash` calls in one response, each a `sleep` of a different
length, and posts the marker while that batch is executing. The wait is read
off the tap, not the SSE stream, because the stream cannot see a tool call
execute: the post goes out once the newest assistant message carrying tool
calls has at least one call with a `tool_execution_start` and no
`tool_execution_end` -- and, if the batch holds more than one call, at least
one already ended, so that "between two calls" and "after the whole batch" are
different positions in the tap. The tap read that satisfies the condition is
the one whose length becomes the cut.

`tool_placement` then reports where the steered `user` message landed against
each call's `tool_execution_start`/`tool_execution_end` and `toolResult`
message and the batch's `turn_end`, by tap index. That a call was demonstrably
still executing when the steer was queued is read from Pi's own ordering --
the `queue_update` naming the marker sits before that call's
`tool_execution_end` -- and a run that cannot show it has not measured the
case and fails. Where the steer landed is recorded, not asserted.

## The model flag

`AGENTS.md` pins the home server's Pi to one model and says the flag is the
whole of the constraint, because `~/.pi/agent/settings.json` is mutable and was
for one day unreadable. This probe passes it explicitly, as
`agentpane_pi_smoke.py` has since OW-yehisa, through the create-session route's
`model` field, which reaches `buildPiSpawnCommand`'s `--model`: the long first
turn's length is a criterion here, so a run that silently answered on a
different model would not be measuring what it reports. The model that actually
answered is read back off the wire regardless, and it is the wire string --
carrying a provider prefix the settings file's string does not -- that the
write-up names.

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
    refs_under,
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

# Staggered so that the batch has a call that has ended while others are still
# running, and long enough that the post lands well inside the second sleep.
# Pi 0.87.1 runs a batch's calls in parallel by default (`toolExecution`
# defaults to "parallel" in pi-agent-core), so these overlap rather than queue.
TOOL_PROMPT = (
    "Use the bash tool. In one single response, issue exactly three bash tool calls together, "
    "not one after another, with exactly these commands: `sleep 4; echo first`, "
    "`sleep 15; echo second`, `sleep 25; echo third`. After all three have returned, reply with "
    "one short sentence listing their outputs."
)


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
            if row["role"] == "toolResult":
                row["toolCallId"] = message.get("toolCallId")
            elif row["role"] == "assistant" and isinstance(message.get("content"), list):
                calls = [
                    block.get("id")
                    for block in message["content"]
                    if isinstance(block, dict) and block.get("type") == "toolCall"
                ]
                if calls:
                    row["toolCallIds"] = calls
        elif kind in ("tool_execution_start", "tool_execution_end"):
            row["toolCallId"] = event.get("toolCallId")
            row["toolName"] = event.get("toolName")
            if kind == "tool_execution_start":
                row["args"] = event.get("args")
            else:
                row["isError"] = event.get("isError")
                row["result_text"] = message_text(event.get("result"))[:200]
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


def batch_state(rows: list[dict[str, Any]], at: int | None = None) -> dict[str, Any] | None:
    """A tool batch in the tap, and how far through executing it is.

    A batch is the tool calls of one assistant `message_end`; Pi executes them
    after that message ends and before the round's `turn_end`. `at` names that
    `message_end` by tap index; without it, the newest batch is read.
    """
    batch = None
    for row in rows:
        if row["type"] == "message_end" and row.get("role") == "assistant" and row.get("toolCallIds"):
            if at is None or row["i"] == at:
                batch = row
    if batch is None:
        return None
    calls = {call_id: {"toolCallId": call_id} for call_id in batch["toolCallIds"]}
    for row in rows:
        if row["i"] <= batch["i"] or row.get("toolCallId") not in calls:
            continue
        call = calls[row["toolCallId"]]
        if row["type"] == "tool_execution_start":
            call["start"] = row["i"]
            call["toolName"] = row.get("toolName")
            call["args"] = row.get("args")
        elif row["type"] == "tool_execution_end":
            call["end"] = row["i"]
            call["isError"] = row.get("isError")
            call["result_text"] = row.get("result_text")
        elif row["type"] == "message_end" and row.get("role") == "toolResult":
            call["toolResult"] = row["i"]
    ordered = [calls[call_id] for call_id in batch["toolCallIds"]]
    return {
        "assistant_message_end": batch["i"],
        "calls": ordered,
        "executing": [call["toolCallId"] for call in ordered if "start" in call and "end" not in call],
        "ended": [call["toolCallId"] for call in ordered if "end" in call],
    }


def ready_to_steer(state: dict[str, Any] | None) -> bool:
    """A call is executing, and -- in a batch of several -- another has ended."""
    if state is None or not state["executing"]:
        return False
    return len(state["calls"]) == 1 or bool(state["ended"])


def tool_placement(
    rows: list[dict[str, Any]], cut: int, marker: str, batch_at_cut: dict[str, Any]
) -> dict[str, Any]:
    """Where the steered text landed against the batch that was executing.

    Every position is a tap index. `user_message` is the `message_start` of the
    `user` message carrying the marker -- the point at which Pi drained its
    steering queue into the conversation. It is compared against the batch's
    `tool_execution_end`s, its `toolResult` messages and the round's
    `turn_end`, which are the three places Pi could have put it after the
    post: between calls, between results, or after the whole batch.

    `executing_at_queue` names the calls whose `tool_execution_end` comes after
    the `queue_update` that put the marker on a queue: Pi's own ordering, and
    not the probe's clock, showing those calls still running when Pi accepted
    the steer.
    """
    # The batch that was executing at the cut, re-read to completion.
    state = batch_state(rows, at=batch_at_cut["assistant_message_end"])
    assert state is not None
    after = [row for row in rows if row["i"] >= cut]
    queue_row = next(
        (
            row
            for row in after
            if row["type"] == "queue_update"
            and any(marker in str(text) for text in (row.get("steering") or []) + (row.get("followUp") or []))
        ),
        None,
    )
    user_row = next(
        (
            row
            for row in after
            if row["type"] == "message_start" and row.get("role") == "user" and row.get("has_marker")
        ),
        None,
    )
    batch_turn_end = next(
        (row["i"] for row in rows if row["i"] > state["assistant_message_end"] and row["type"] == "turn_end"),
        None,
    )
    ends = [call["end"] for call in state["calls"] if "end" in call]
    results = [call["toolResult"] for call in state["calls"] if "toolResult" in call]
    complete = len(ends) == len(state["calls"]) and len(results) == len(state["calls"])

    placement = None
    if user_row is not None and complete and batch_turn_end is not None:
        u = user_row["i"]
        if u < max(ends):
            placement = "between_calls_before_batch_finished"
        elif u < max(results):
            placement = "after_executions_between_tool_results"
        elif u < batch_turn_end:
            placement = "after_tool_results_before_turn_end"
        else:
            placement = "after_batch_turn_end"

    executing_at_queue = (
        []
        if queue_row is None
        else [call["toolCallId"] for call in state["calls"] if call.get("end", -1) > queue_row["i"]]
    )

    # What Pi did next, so the reader can see the round the steer opened.
    following = None
    if user_row is not None:
        following = [
            row
            for row in rows
            if row["i"] > user_row["i"]
            and row["type"] in ("turn_start", "turn_end", "message_end", "agent_end", "agent_settled")
        ][:8]

    return {
        "placement": placement,
        "batch_complete": complete,
        "batch": state,
        "batch_turn_end": batch_turn_end,
        "queue_update": queue_row["i"] if queue_row else None,
        "user_message_start": user_row["i"] if user_row else None,
        "executing_at_queue": executing_at_queue,
        "events_after_user_message": following,
    }


def wait_for_tap(tap: Path, marker: str, predicate: Any, timeout: float, label: str) -> tuple[Any, int]:
    """Poll the tap until `predicate(rows)` is truthy; return it and that read's length.

    The length returned is the cut: the condition and the pin come from the
    same read of the file, so the posted request is strictly later than every
    line the condition saw.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = tap_events(tap)
        found = predicate(timeline(raw, marker))
        if found:
            return found, len(raw)
        time.sleep(0.05)
    raise TimeoutError(f"timed out waiting for {label}")


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
    parser.add_argument(
        "--turn",
        choices=("text", "tool"),
        default="text",
        help="steer into a long text turn (OW-yuyofu, the default) or into an executing tool batch (OW-nufitu)",
    )
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
        "card": "OW-yuyofu" if args.turn == "text" else "OW-nufitu",
        "turn": args.turn,
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
        # D9: Pi's id is its JSONL path, adopted at attach or on the first
        # prompt, so the ref moves under this probe. Every reading below is
        # keyed by the handle instead, which a rename never changes (D24), and
        # every request goes to the attach reply's ref, which the server keeps
        # honouring whatever the session is called later.
        attached_ref = attached["session"]["ref"]
        handle = attached["session"]["handle"]

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

        # -- 1. a turn to steer into -------------------------------------
        long_start = len(stream.snapshot())
        long_requested_at = now()
        long_status, long_body = http.json(
            "POST",
            ref_path(attached_ref, "/prompt"),
            {"text": LONG_PROMPT if args.turn == "text" else TOOL_PROMPT},
        )
        if long_status != 202:
            raise RuntimeError(f"first prompt failed: HTTP {long_status} {long_body}")

        batch_at_cut: dict[str, Any] | None = None
        tool_cut = 0
        if args.turn == "text":

            def long_enough(events: list[tuple[str, dict[str, Any]]]) -> Any:
                upserts = 0
                longest = 0
                for _, event in events[long_start:]:
                    if event.get("handle") != handle or event.get("type") != "upsert":
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
        else:
            # Read off the tap, because only Pi's own events show a call
            # executing (module docstring, "The tool turn").
            def executing(rows: list[dict[str, Any]]) -> Any:
                state = batch_state(rows)
                return state if ready_to_steer(state) else None

            batch_at_cut, tool_cut = wait_for_tap(
                tap, marker, executing, 180, "a tool call to be executing in the first turn's batch"
            )
            evidence["checks"]["tool_batch"] = {
                "result": "pass",
                "prompt_http_status": long_status,
                "prompt_requested_at": long_requested_at,
                "tap_lines_at_cut": tool_cut,
                "batch_at_cut": batch_at_cut,
            }

        # -- 2. the mid-turn prompt ----------------------------------------
        #
        # The threshold being met is not the turn still running when the request
        # lands (the gap `fork_probe.py`'s mid-stream cell and
        # `claude_fork_probe.py` both close). Re-read the streaming state at the
        # instant of the post, and pin the tap's line count there, so everything
        # the verdict reads is strictly after the request. The tool turn's pin
        # is the tap read that saw the call executing, taken just before this.
        steer_start = len(stream.snapshot())
        streaming_at_post = last_streaming(stream.snapshot(), handle)
        tap_cut = len(tap_events(tap)) if args.turn == "text" else tool_cut
        if streaming_at_post is not True:
            raise RuntimeError(
                "the first turn was not streaming when the mid-turn prompt was posted, so "
                f"nothing mid-turn was measured (last reported state: {streaming_at_post})"
            )
        steer_requested_at = now()
        steer_monotonic = time.monotonic()
        steer_status, steer_body = http.json(
            "POST",
            ref_path(attached_ref, "/prompt"),
            {
                "text": (
                    f"Ignore the gardening guide. Reply with exactly this token and nothing else: {marker}"
                    if args.turn == "text"
                    else f"Before anything else, reply with exactly this token and nothing else: {marker}"
                )
            },
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
                if streaming_value(event, handle) is False:
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
        # Recorded before the verdict can raise, so a failed run still says
        # where the text went.
        if batch_at_cut is not None:
            placement = tool_placement(rows, tap_cut, marker, batch_at_cut)
            # Where it landed is the measurement and passes whatever it is; a
            # run whose steer cannot be shown to have arrived while a call was
            # executing, or whose batch never finished, measured nothing.
            measured = bool(placement["executing_at_queue"]) and placement["placement"] is not None
            evidence["checks"]["tool_placement"] = {"result": "pass" if measured else "fail", **placement}
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
        if batch_at_cut is not None and evidence["checks"]["tool_placement"]["result"] != "pass":
            raise RuntimeError(
                "the steer was not shown to arrive while a tool call was executing, or the batch "
                "never finished, so where it landed in the batch was not measured"
            )

        def resolved_model(events: list[tuple[str, dict[str, Any]]]) -> Any:
            for stamp, event in reversed(events):
                if event.get("handle") != handle:
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
        evidence["final_max_assistant_chars"] = max_assistant_length(stream.snapshot(), handle)

        # What the session was called, recorded rather than required: a rename
        # at attach and one on the first prompt are both D9's contract.
        refs = refs_under(stream.snapshot(), handle)
        current = refs[-1] if refs else attached_ref
        evidence["session"] = {
            "handle": handle,
            "refs": refs,
            "renamed_during": (
                "attach"
                if not attached_ref["id"].startswith("virtual:")
                else "first prompt"
                if not current["id"].startswith("virtual:")
                else None
            ),
            "session_id_is_jsonl_path": current["id"].endswith(".jsonl"),
        }

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
