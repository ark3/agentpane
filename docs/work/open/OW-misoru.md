---
kind: defect
where: '`buildClaudeSpawnCommand` in `src/server/adapters/claude/process.ts`'
---

# Pass `--verbose` unconditionally: claude 2.1.246 requires it again under `-p --output-format stream-json`, and the adapter never passes it.

OW-yilabe found `--verbose` unnecessary on 2.1.238 and OW-beripo dropped it
from the invocation. That finding was correct and stays correct for 2.1.238 —
what changed is the CLI. On **2.1.246** the flag is required again under `-p
--output-format stream-json`, so the adapter's spawn shape does not stream at
all against a current CLI. Reported by the owner 2026-08-26; the exact version
where the requirement returned is unknown, and 2.1.246 is the earliest version
known to require it.

The decision is **unconditional** — push `--verbose` into the static `args`
array rather than gating on a detected version. Taken by the owner on
2026-08-26, on the evidence below that the flag is inert on the older version:
there is no version to branch on that we can name, and nothing is bought by
branching.

## Evidence already in hand, so nobody re-runs it

Probed live on the home server on 2026-08-26 (Haiku, per the OW-yilabe /
OW-beripo authorization), on the home server's installed `claude 2.1.238`.
The real invocation shape was run twice over the same one-line stream-json
input, once with `--verbose` and once without. Both exited 0, both wrote pure
JSONL to stdout (every line parses; no human-readable logging leaked into the
stream, which was the failure mode worth fearing), both left stderr empty, and
both produced an identical event sequence — `system/init`, `system/status`,
`rate_limit_event`, `message_start`, a thinking block with `signature_delta`,
`assistant`, a text block, `assistant`, `message_delta`, `message_stop`,
`result/success` — with identical key sets on the `init` and `result` events.
The runs differed only by one `thinking_delta` pair, which is model variance.

So on 2.1.238 the flag is accepted and inert. That is the whole basis for
making it unconditional.

## Done when

`--verbose` is in the base `args` array, and the three sites that currently
record the opposite each name **both** versions rather than simply flipping —
"2.1.238 does not need it, 2.1.246 requires it, so we always pass it". Flipping
them to "it is needed" would be as wrong as what it replaces, in the other
direction. The sites:

- the docblock above `buildClaudeSpawnCommand`,
  `src/server/adapters/claude/process.ts:61`
- the `--verbose` row of the OW-yilabe table, `docs/MANUAL_TESTING.md:746`
- OW-beripo's close note, `docs/work/closed/OW-beripo.md:81`

The 2.1.238 probe above belongs in `docs/MANUAL_TESTING.md` as the grounding
for "inert on the older version", since that is what licenses the unconditional
choice.

## Success criteria

`src/server/adapters/claude/process.test.ts:19` — "builds the sandboxed base
invocation (D7), without --verbose or --permission-mode" — asserts
`expect(args).not.toContain("--verbose")` and pins `BASE`. It fails on the
change and is the handle: invert that assertion and the `BASE` constant, watch
the old form go red first. Its name and comment both mention `--verbose` and
must be rewritten with it; the `--permission-mode` half of the assertion stands
unchanged, because sbox still injects that itself.

`bun run check` passes.

## Left open, and deliberately not blocking

Two things could not be settled on the home server, which runs 2.1.238 and
cannot be updated right now (owner, 2026-08-26):

- The requirement itself is **unreproduced here**. It is the owner's report,
  not a capture. Whoever next drives a current CLI should confirm it and record
  the observed failure without the flag.
- `--verbose` was probed only against the base shape. Its composition with
  `--resume-session-at`, `--fork-session`, and `--session-id` is unprobed. The
  parser treats it as an independent boolean, so a conflict is unlikely — but
  that is reasoning, not evidence.

Whatever those turn up, record it in `docs/MANUAL_TESTING.md`; if the first one
turns up a narrower requirement than reported, say so there and revisit whether
unconditional is still the right call.
