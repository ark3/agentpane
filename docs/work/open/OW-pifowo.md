---
kind: defect
where: '`src/server/adapters/pi/process.ts:343-360`'
---

# Pi's `fork` is copy-on-write, so the adapter's docblock is wrong and its returned ref may be stale.

**Work laptop:** needs a live Pi run.

OW-mewiga ran the first Pi fork (HANDOFF 43, `MANUAL_TESTING.md`): on 0.84.2
`fork` does **not** "rewind the active branch of the SAME session file in place"
as the docblock at `process.ts:343-360` claims. It is copy-on-write — the active
file is left byte-identical and the post-fork re-ask lands in a *new* file
carrying a `parentSession` pointer back. Two things follow, and this item is
both:

- The docblock is now false and should say copy-on-write, since the next reader
  of `fork()` will reason from "in place" and be wrong about what is on disk.
- `fork()` returns `this.ref` unchanged (`process.ts` returns the same
  `SessionRef` it held), but the backend's active session file moved. So the
  server's notion of the session id may diverge from Pi's actual active file
  after a fork — the adapter likely has to re-adopt the new `sessionFile` the
  way `start()`'s rename path does. Whether it must, and what breaks if it does
  not (a subsequent turn written to the abandoned file? a listing that indexes
  the stale id?), is unverified and is what this item settles.

This is the Pi half of OW-22's concern, which OW-22 framed as Codex-only ("Pi's
`fork` rewinds the *same* session file and returns the same ref"). OW-mewiga's
evidence shows that premise was itself wrong, so OW-22's Pi assumption needs
revisiting alongside this. Settle against the running CLI, not the docblock:
`resources/probes/fork_probe.py`'s `pi_rewind` cell already reproduces the
copy-on-write behaviour and is the place to prove what the adapter must do.
