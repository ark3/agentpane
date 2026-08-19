---
kind: unverified
where: '`resources/probes/fork_probe.py` `pi_rewind` cell (`:338-406`), `src/server/adapters/pi/process.ts` `fork()`'
---

# Two things about Pi's fork that the edit gesture rests on are unproven: whether the rewound branch keeps the message you forked at, and what a fork does to a turn in flight.

**Work laptop:** both need a live Pi run.

OW-hezidi builds edit-and-fork against the contract *"fork at message N, and
the new session ends just before it"*. Codex already honours that --
`lastTurnId` is inclusive, so `codex/adapter.ts:398` deliberately passes
`turnOrder[index - 1]`. Pi has never been asked. Neither question touches
client code: the first moves at most one line in `pi/process.ts`, the second
decides whether one of OW-hezidi's first cuts becomes permanent.

## Does Pi's fork keep the entry it forked at?

If it does, the edited message lands *after* the original instead of replacing
it and the user sees both -- the feature visibly broken on one backend. The fix
is then the same index shift Codex already makes, inside `pi/process.ts` and
nowhere else.

**The captured fixture narrows this but does not settle it**, and that reading
should not have to be redone. `resources/fixtures/pi/fork.jsonl` is the
post-fork file from OW-mewiga's run: its header carries `parentSession` back to
the original, and its body is the re-ask onward -- `DELTA`, then `EPSILON` --
with no trace of the `ALPHA` that was forked at, nor of the abandoned `BETA`.
Its first entry's `parentId` is `null` rather than a link into the parent
file's chain. That is what exclusive semantics would look like. What keeps it
from being proof is the probe's choice at `fork_probe.py:361`: it forked at
`forks[0]`, the **first** user message, where "kept everything before it" and
"kept nothing at all" are the same file, and where "the ancestry lives in the
parent file and is not duplicated here" is not excluded either.

**The deciding run is a fork at the second user message**, with three turns
primed rather than two. It is an addition to the existing `pi_rewind` cell, not
new apparatus.

## What does a fork do to a turn already running?

Codex is untroubled: `thread/fork` mints a separate thread and the parent keeps
streaming, so a fork mid-turn disturbs nothing. Pi is one process driving one
active session file, and its fork **moves that file out from under it** at the
call itself (finding 43, `active_file_moves_at_fork: true`). A running turn and
a fork are competing for the same process. Whether Pi refuses, aborts the turn
implicitly, or does something undefined is unknown, and the structural squeeze
is real enough that it should not be discovered in front of a user.

OW-hezidi ships aborting first on **both** backends to sidestep this. The
owner's preference is that forking otherwise not abort, which is available on
Codex today -- but offering it on one backend and not the other reads as a bug,
so this answer is what unblocks it. If Pi cannot fork mid-turn at all, then
abort-first is not a first cut on Pi, it is the only thing available, and
saying so is a result rather than a failure.

## Done when

`MANUAL_TESTING.md` carries a live-run record for both, produced by the
re-runnable `pi_rewind` cell rather than by hand:

1. A fork taken at the **second** user message, recording whether that message
   is present in the rewound branch, read off `get_messages` and off the file
   on disk -- not off the fork response, which finding 30 shows cannot be
   trusted on its own.
2. A fork attempted while a turn is streaming, recording what `fork` returns,
   what `get_state` then reports as the active file, and what became of the
   turn.

Then, conditionally: if Pi keeps the forked-at entry, `pi/process.ts` `fork()`
shifts to the preceding entry the way `codex/adapter.ts:398` does, pinned by a
test in `pi/process.test.ts` watched red first. If Pi cannot fork mid-turn,
that is recorded in OW-hezidi's own file as settled rather than deferred.
