---
kind: defect
where: '`src/server/adapters/pi/process.ts` fork() / `src/server/http/session-manager.ts`'
---

# A Pi session detached between a fork and the next prompt strands the fork on disk.

**Work laptop:** needs a live Pi run to reproduce the disk state.

OW-pifowo settled that Pi's `fork` is copy-on-write and moves the process's
active `sessionFile` to a new file (F2) *at the fork call*, but F2 does not
materialise on disk until the next prompt (`moved_file_on_disk_at_fork: false`
in `fork_probe.py`'s `pi_rewind` cell; `docs/MANUAL_TESTING.md`, "Settling the
fork's returned ref"). The fix there has the live adapter adopt F2 as its ref
immediately, so an in-memory session keeps working.

The gap: if that adapter is **disposed after the fork but before any prompt**,
F2 was never written. A later `attach` on F2 goes through `SessionIndex.get`
(`session-manager.ts` `#start`, the `!existing` branch), which walks the store
and finds nothing — the fork is unreachable. Worse, F1 still holds the
*abandoned pre-fork* branch, so resuming the only file that exists on disk
replays the branch the user forked away from (the resume proof in
MANUAL_TESTING.md showed F1 replays the abandoned branch, F2 the fork).

What this item settles: whether the server must force F2 to materialise at fork
time (e.g. an empty-prompt or explicit-flush path, if Pi's RPC has one — check
`rpc.md` against the 0.84.2 binary) or must otherwise pin the fork so a
dispose-before-prompt cannot lose it. Confirm the failure first: fork, dispose
without prompting, attach the returned ref, and observe the not-found. Success
is a test that reproduces the strand and a path that makes the returned fork ref
re-attachable without a prior prompt — or, if that is judged not worth the
mechanism, an explicit decision recorded here that a fork is only durable once
prompted, with the browser flow constrained to match.
