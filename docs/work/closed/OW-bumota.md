---
kind: unverified
where: '`buildClaudeSpawnCommand` in `src/server/adapters/claude/process.ts`'
---

# Confirm on a current claude CLI that `--verbose` is required and composes with the resume and fork flags; the home server cannot, at 2.1.238.

Filed at OW-misoru's close (2026-08-26), which shipped `--verbose` in the
adapter's static spawn args on the owner's report that claude **2.1.246**
requires it again under `-p --output-format stream-json`. That change is right
either way — the flag was probed inert on 2.1.238 — but two things behind it
are unproven, and both need a machine running a current CLI. The home server
runs 2.1.238 and cannot be updated right now (owner, 2026-08-26), so neither
can be settled there.

- **The requirement itself is unreproduced.** It is the owner's report, not a
  capture. Confirm it, and record the observed failure *without* the flag —
  what the CLI actually does when it is missing (exit code, stderr, whether it
  refuses at parse time or streams nothing) is the part nobody has seen.
- **Composition is unprobed.** OW-misoru probed `--verbose` only against the
  base shape. Its interaction with `--resume`, `--resume-session-at`,
  `--fork-session`, and `--session-id` rests on reasoning — the parser treats
  it as an independent boolean — not on evidence. `docs/MANUAL_TESTING.md`'s
  OW-mayuza section has the fork invocation to extend.

Also worth capturing while a current CLI is in hand: the version where the
requirement returned. OW-misoru could name only 2.1.246, the earliest known to
require it, and deliberately did not invent a boundary.

Whatever comes back, record it in `docs/MANUAL_TESTING.md` under the existing
section "`--verbose` inert on 2.1.238, required again on 2.1.246 (OW-misoru)",
which already states both open questions in its closing paragraph and is the
place a reader will look. If the requirement turns out narrower than reported —
a specific flag combination rather than `-p --output-format stream-json` as a
whole — say so there and revisit whether passing it unconditionally is still
the right call; if it is exactly as reported, say that too, so the next reader
stops re-asking.

## Success criteria

The observed behaviour of a current CLI without `--verbose`, pasted into
`docs/MANUAL_TESTING.md` from a real run, and a run of the full spawn shape —
`--verbose` together with `--resume-session-at <uuid> --fork-session` — showing
whether the stream is unaffected. No code change is expected; if one turns out
to be needed, that is a new item, not this one.

**Fixed** in 55fcc9c: the item's own premise was stale — the home server was no
longer pinned at 2.1.238 but running **claude 2.1.247**, so both questions were
settled there on 2026-08-27 (Haiku, per OW-yilabe / OW-beripo), recorded in
`docs/MANUAL_TESTING.md` under the OW-misoru section. The requirement does not
reproduce: a current CLI streams stream-json under `-p` with **no `--verbose`
at all**, exit 0 and empty stderr, in both the plain shape and the full adapter
shape. There is no failure to record because the check is not in the binary —
the CLI's flag-validation table greps out of the executable and holds no
`--verbose` entry on either 2.1.247 or 2.1.238. Composition is clean: the fork
shape (`--resume --resume-session-at --fork-session --session-id`) run with and
without the flag produced **identical event sequences, event for event**, same
session id echo, same truncated fork store file, parent file sha256 unchanged.
No version boundary is claimed — 2.1.246 was not installed and was not probed,
so the owner's report stands as reported and the honest reading is that the
requirement, if it existed, was transient. Passing `--verbose` unconditionally
still stands, but for a better reason: it is harmless, not needed. The same
commit retires the falsified copy of the old rationale in the
`buildClaudeSpawnCommand` docblock (`src/server/adapters/claude/process.ts`),
which a reader meets at the code. Probes ran `claude` directly, not through
`direnv exec <cwd> sbox --` (the home server has no `direnv`); that caveat is
stated at the evidence.
