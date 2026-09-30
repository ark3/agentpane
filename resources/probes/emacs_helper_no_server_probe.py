"""Does the Emacs helper answer a request waiting on its first stream open,
when no server is listening, before it exits? (OW-pezelo)

Runs the real helper, `bun run src/emacs/main.ts`, against a loopback port
nothing listens on, with its stdin held open as Emacs holds it, and sends a
`sessions/list` and a `sessions/attach`, the two requests that open the
stream. Each run prints the helper's exit and every reply it wrote; the probe
passes only when, in every run, both replies are errors saying the server
could not be reached, with no `data`, and the helper exited.

    python3 resources/probes/emacs_helper_no_server_probe.py

Run from the repository root; PROBE_RUNS sets the runs (3). No network beyond
loopback, no model calls.
"""

import json
import os
import subprocess
import sys
import time

RUNS = int(os.environ.get("PROBE_RUNS", "3"))
# Port 1 is privileged and unused on the home server, so the connect is refused.
URL = "http://127.0.0.1:1"


def frame(message):
    body = json.dumps(message).encode()
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


def replies(data):
    out = []
    while data:
        head, _, rest = data.partition(b"\r\n\r\n")
        length = int(head.split(b":")[1])
        out.append(json.loads(rest[:length]))
        data = rest[length:]
    return out


def run():
    helper = subprocess.Popen(
        ["bun", "run", "src/emacs/main.ts", URL],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    # The helper loads its markdown renderer, about a second, before it reads a frame.
    time.sleep(2.5)
    sent = time.monotonic()
    helper.stdin.write(
        frame({"jsonrpc": "2.0", "id": 1, "method": "sessions/list"})
        + frame({"jsonrpc": "2.0", "id": 2, "method": "sessions/attach", "params": {"session": {"backend": "pi", "id": "x"}}})
    )
    helper.stdin.flush()
    # stdin stays open: the helper must exit on the failed open, not on its input's end.
    while helper.poll() is None and time.monotonic() - sent < 5:
        time.sleep(0.01)
    exited = helper.poll()
    if exited is None:
        helper.kill()
    got = replies(helper.stdout.read())
    ok = (
        exited == 0
        and sorted(r["id"] for r in got) == [1, 2]
        and all("result" not in r and "reach" in r["error"]["message"] and "data" not in r["error"] for r in got)
    )
    print(f"exit {exited} after {time.monotonic() - sent:.2f}s, {'ok' if ok else 'FAILED'}")
    for r in got:
        print("  ", json.dumps(r))
    return ok


passed = sum(run() for _ in range(RUNS))
print(f"ANSWERED {passed} of {RUNS}")
sys.exit(0 if passed == RUNS else 1)
