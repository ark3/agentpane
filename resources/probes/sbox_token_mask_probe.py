#!/usr/bin/env python3
"""A command run through `sbox` cannot read `~/.ssh/agentpane-token`.

Why it exists: agentpane's server keeps its API token in
`~/.ssh/agentpane-token` because `sbox` hides `~/.ssh` from every agent -- on
Linux (bwrap) it mounts a tmpfs there holding only a seeded `config`, and on
macOS (seatbelt) it denies reads under it. That is a side effect of `sbox`'s
ssh mask, not something agentpane controls, so this probe guards it.

Run it **outside any sandbox**. It:

1. Ensures the token file exists, creating it exactly as `loadApiToken` in
   `src/server/api-token.ts` does when absent -- exclusively, mode `0600`, 32
   random bytes in base64url -- and never altering an existing one. It applies
   the same refusals: no `~/.ssh` (not created), a file not owned by the
   running user, one with any group or other permission bit, or one holding
   only whitespace.
2. Runs `sbox --profile none --workspace <fresh temp dir> -- sh -c ...` from
   that temp dir, which prints a per-run random sentinel and then `cat`s the
   token file's path, expanded here, outside the sandbox. `--profile none` and
   the explicit workspace are what `sbox` needs to start at all: without them
   it exits 1 before any sandbox exists (`No mount profile for ...`,
   `Could not detect workspace`), which would look like a refused read.

Verdict, by exit status:

* **0, pass**: the sentinel arrived and what followed it does not contain the
  token -- the read failed, or it read some other file at that path.
* **1, fail**: the sandboxed read returned the token. The token itself is
  never printed; nothing the sandbox wrote is echoed without the token
  redacted.
* **2, inconclusive**: no sentinel, so the sandboxed command never ran (or
  `sbox` could not be found); this is never a pass.
* **3, refused to run**: already inside `sbox`, or the token file breaks one
  of the server loader's rules.

How "already inside `sbox`" is detected: `sbox` sets `SBOX=1` in the command's
environment on both backends, and on Linux bwrap mounts a tmpfs at `~/.ssh`,
which shows as a mount point in `/proc/self/mountinfo`. Either refuses the
run. The mount check backs up the variable, which a child can unset; seatbelt
mounts nothing, so on macOS the variable is the only signal.
"""

from __future__ import annotations

import argparse
import base64
import os
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from agentpane_live_support import API_TOKEN_PATH

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_INCONCLUSIVE = 2
EXIT_REFUSED = 3


class Refused(Exception):
    """The probe must not run; the message says why."""


def unescape_mountinfo(field: str) -> str:
    # mountinfo escapes space, tab, newline and backslash as \ooo octal.
    out, i = [], 0
    while i < len(field):
        if field[i] == "\\" and field[i + 1 : i + 4].isdigit() and i + 4 <= len(field):
            out.append(chr(int(field[i + 1 : i + 4], 8)))
            i += 4
        else:
            out.append(field[i])
            i += 1
    return "".join(out)


def ssh_dir_is_a_mount_point(ssh_dir: Path) -> bool:
    try:
        lines = Path("/proc/self/mountinfo").read_text().splitlines()
    except OSError:
        return False
    target = str(ssh_dir.resolve())
    return any(
        len(fields) > 4 and unescape_mountinfo(fields[4]) == target
        for fields in (line.split(" ") for line in lines)
    )


def refuse_inside_sbox(ssh_dir: Path) -> None:
    if os.environ.get("SBOX") == "1":
        raise Refused(
            "already inside sbox (SBOX=1 is set): the ~/.ssh this process sees is "
            "the sandbox's, not the real one. Run this probe outside any sandbox."
        )
    if ssh_dir_is_a_mount_point(ssh_dir):
        raise Refused(
            f"already inside sbox ({ssh_dir} is a mount point, as bwrap's tmpfs "
            "mask makes it): the ~/.ssh this process sees is the sandbox's, not "
            "the real one. Run this probe outside any sandbox."
        )


def ensure_token(path: Path) -> str:
    """The token, creating its file when absent; `loadApiToken`'s rules."""
    ssh_dir = path.parent
    if not ssh_dir.is_dir():
        raise Refused(
            f"{ssh_dir} does not exist, and agentpane keeps its API token in {path}. "
            f"Create it (mkdir -m 700 {ssh_dir}); this probe does not, as the server does not."
        )
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        try:
            os.write(fd, token)
        finally:
            os.close(fd)
        print(f"created {path} (0600), as the server would have")

    # Check and read through one descriptor, so the file checked is the file read.
    fd = os.open(path, os.O_RDONLY)
    try:
        st = os.fstat(fd)
        if st.st_uid != os.getuid():
            raise Refused(f"{path} is owned by uid {st.st_uid}, not by the running user (uid {os.getuid()}).")
        if st.st_mode & 0o077:
            raise Refused(f"permissions {stat.S_IMODE(st.st_mode):04o} for {path} are too open; the server refuses them.")
        with os.fdopen(os.dup(fd), "rb") as f:
            content = f.read().decode("utf-8").rstrip()
    finally:
        os.close(fd)
    if content == "":
        raise Refused(f"{path} holds no token; the server refuses it.")
    return content


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sbox", default=shutil.which("sbox"), help="sbox executable (default: sbox on PATH)")
    args = parser.parse_args()
    # Keep stdout and stderr lines in the order they were written.
    sys.stdout.reconfigure(line_buffering=True)

    path = API_TOKEN_PATH
    try:
        refuse_inside_sbox(path.parent)
        token = ensure_token(path)
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return EXIT_REFUSED

    if not args.sbox:
        print("INCONCLUSIVE: no sbox on PATH; pass --sbox PATH", file=sys.stderr)
        return EXIT_INCONCLUSIVE

    sentinel = f"sbox-token-mask-probe-ran-{secrets.token_hex(16)}"
    with tempfile.TemporaryDirectory(prefix="sbox-token-mask-") as workspace:
        cmd = [
            args.sbox, "--profile", "none", "--workspace", workspace, "--",
            "sh", "-c", 'printf "%s\\n" "$1"; cat "$2"', "sh", sentinel, str(path),
        ]
        print(f"running: {shlex.join(cmd)}")
        proc = subprocess.run(cmd, cwd=workspace, capture_output=True)

    stdout = proc.stdout.decode("utf-8", "replace")
    stderr = proc.stderr.decode("utf-8", "replace").replace(token, "<token redacted>")
    if stderr.strip():
        print("sbox stderr:\n" + stderr.rstrip())

    head, sep, read = stdout.partition("\n")
    if head != sentinel or not sep:
        print(
            f"INCONCLUSIVE: sbox exited {proc.returncode} without the sandboxed command "
            "printing its sentinel, so the read never ran; this is not a pass.",
            file=sys.stderr,
        )
        return EXIT_INCONCLUSIVE

    if token in read:
        print(
            f"FAIL: a command run through sbox read {path}, the agentpane API token "
            "(content not shown). sbox no longer masks ~/.ssh for this run. Look at what "
            "exposes it: `sbox --ssh` and `sbox --rw ~/.ssh` both do by design, so check "
            "the default ssh mask in sbox (SSH_DIR, and the bwrap tmpfs or seatbelt deny "
            "built from it) and any wrapper that adds those flags.",
            file=sys.stderr,
        )
        return EXIT_FAIL

    outcome = f"the read failed (exit {proc.returncode})" if proc.returncode else "it read some other file at that path"
    print(f"PASS: the sandboxed command ran, and {outcome}; it did not return the token in {path}.")
    return EXIT_PASS


if __name__ == "__main__":
    sys.exit(main())
