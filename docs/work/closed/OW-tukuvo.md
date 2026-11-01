---
labels: [defect, emacs]
closed: promoted
---

# A fork in flight is held per Emacs buffer, so a sibling buffer on the same session attaches or forks again while it is out

In `emacs/agentpane.el`, "a fork of this session is in flight" is the buffer-local boolean `agentpane--forking`, set by `agentpane--fork-points` and cleared by the fork's reply or FAILED in `agentpane--fork-at`, and read by `agentpane--refuse-forking`, `agentpane-edit`, `agentpane-edit-last` and `agentpane--send-edit`.
But the state belongs to the session, not to the buffer: on Pi the parent's live process moves onto the fork (the `agentpane-fork` docstring, D24, D26), and an attach sent meanwhile from any buffer on that session resumes the parent's old branch, which is exactly what `agentpane--refuse-forking`'s docstring says the flag exists to stop.

OW-larele (closed 2026-10-15) made a merge's survivor answer the fork chain the merged-away buffer had in flight (`agentpane--request`'s ALWAYS `follow`, `agentpane--absorber`), and, so the survivor refuses an attach meanwhile, `agentpane--absorb` copies OTHER's `agentpane--forking` into it.
That copy is a guard at the site, and OW-larele's adversarial read named two cases it misses:

1. Two forks in one buffer, the first answer freeing it while the second is out (introduced by the copy, confirmed by an ERT probe on 2026-10-15).
   OTHER forks with `sessions/fork` held; the survivor, not attached, has an edit open and sends it, so `agentpane--send-edit` queues its fork chain as a waiter on its attach; the attach's snapshot merges OTHER, copying `forking` as t; the attach reply runs the waiter, which sends forkPoints and a second `sessions/fork` with nothing refusing it, since `agentpane--fork-points` reads no flag.
   OTHER's fork answers and clears the survivor's `agentpane--forking` with the second still out, and a plain `agentpane--attach` from the survivor then goes out.
   A FAILED from either fork clears the flag the other set the same way.
2. A sibling buffer's attach landing after the server's fork (pre-existing, by reading only, not run).
   The survivor's attach above went out while OTHER was forking, and no flag refused it, because it lives in OTHER.
   On Pi, if that attach reaches the server before `#forkOnto` in `src/server/http/session-manager.ts`, its snapshot comes under OTHER's handle and the merge handles it; if after, the server resumes the parent's old branch under a new handle, no merge happens, and the survivor is attached to that respawn.

The reader's probe for case 1, which passed on the OW-larele branch to show the defect, is reproduced here in outline: in `agentpane-test--merging` with `hold '(sessions/fork sessions/attach)`, fork from `holder` at index 0, then in `previewing` draw `agentpane-test--image-nodes`, `agentpane--start-edit` its first node and `agentpane-send`; deliver the attach; two `sessions/fork` are now held; answer the first, and `previewing`'s `agentpane--forking` is nil and `agentpane--attach` sends `sessions/attach`.

What is load-bearing: while a fork of a session is in flight, no buffer on that session sends an attach or begins a second fork, and the state saying so has one owner keyed by the session (its ref or handle, whichever survives the merge and the Pi detach -- the executor settles which and says why), not a per-buffer flag copied at merges.
Which buffer the fork's reply answers in is OW-larele's and stays as it is.

Done when ERT tests in `emacs/agentpane-test.el`, run as that file's Commentary says, go red before and green after for case 1 (no second fork goes out, or no attach goes out while either fork is out -- say which the remedy chose) and for case 2 as far as the client can see it (a second buffer on the session refuses its attach while the first's fork is out), and `agentpane--absorb` no longer copies `agentpane--forking`: the copy OW-larele added is gone, not joined by more checks.
Retire every docstring claim the change makes false; OW-larele left "refusing every attach and a second fork as OTHER did" in `agentpane--absorb` and "one fork at a time per buffer" in `agentpane-fork` standing on the copy.

## Close note

Promoted to ark3/agentpane#17 during the card triage, 2026-11-01.
The rework of agentpane-mode's forking rebuilds this code path, so the issue carries both cases as a constraint: the fork-in-flight state has one owner keyed by the session, and the copy in agentpane--absorb goes.
