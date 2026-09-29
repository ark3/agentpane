---
labels: [defect, emacs]
blocked-by: [OW-rebawa]
---

# The Emacs helper answers an attach by ref with a snapshot of an older container under that ref, so when another client closes it and the attach spawns a new one, the buffer is fed the dead handle until the next listing

Found 2026-09-28 by the second adversarial read of OW-rebawa, reproduced in the `src/emacs/helper.test.ts` harness (a probe, not a committed test); not seen on loopback in normal use.

## What happens

Since OW-rebawa, the helper in `src/emacs/helper.ts` keeps an `Attaching` record per `sessions/attach` in flight.
`introduce` answers an attach whose reply has not come yet by the ref it asked for: the first `session/snapshot` under that ref answers it, records the attachment under that snapshot's handle, and sends it tagged `askedFor`.
The ordering it gets wrong:

1. Emacs attaches ref R.
2. A snapshot under handle H1 for ref R arrives first, from another client's attach or from an opening snapshot, and `introduce` answers the attach with it and records H1.
3. Meanwhile another client closes H1, or a fork lets it go, so the server's attach spawns H2 and the reply names H2.
4. H2's snapshot and every later event under it are dropped, since the attach is already `done` and nothing is recorded under H2.

In `emacs/agentpane.el`, `agentpane--attach`'s reply callback sees the buffer attached (to H1), so its waiters run, and a first prompt goes by ref to H2, whose events never reach the buffer.
It heals at the next `sessions-changed`, when `dropDead` detaches H1 and the buffer is dropped, and `g` attaches again.

## What is load-bearing

The race needs a close or fork by another client inside one attach's round trip.
The helper cannot know the reply's handle before the reply, and answering by ref before it is what lets a snapshot that beats its reply attach the buffer (OW-rebawa's measurement: the REST reply beat the snapshot in about half of cold attaches on loopback), so answering only by handle is not a fix.
The reader's suggestion, a guess and not a decision: remember the handle each attach was answered under, and at the reply, where it differs from `summary.handle`, treat the answer as wrong, for instance by detaching the old handle for that buffer and waiting for (or sending) the snapshot under the reply's handle.
Whatever the fix, a buffer must still be attached only by a snapshot (D25, "What the run found, and the two ownership changes it asked for", in `docs/DESIGN.md`), and a reply must still go out only after the snapshot that attaches the buffer.

## Done when

A test in `src/emacs/helper.test.ts`, red first, drives the ordering above with the fake event source and `fetch` the file's other tests use, and asserts that Emacs ends up attached to the reply's handle and receives its events, or ends not attached with the reply sent after a `session/detached` for the old handle, whichever the fix chooses.
`bun run check` passes, and so does `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
