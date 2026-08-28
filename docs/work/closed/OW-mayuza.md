---
labels: [unverified]
---

# Hidden `--resume-session-at` should make pre-tip fork real for Claude Code, overturning OW-yilabe's tip-only finding — one Haiku run settles it and every copy follows.

`docs/MANUAL_TESTING.md` OW-yilabe section; `resources/fixtures/claude/`; `docs/work/open/OW-beripo.md`

**Home server:** needs one live `claude` turn, Haiku only (`--model haiku`),
under the standing authorization from OW-yilabe (owner, 2026-08-25).

OW-yilabe recorded "no pre-tip fork exists headless", from two accurate
probes: `--help` (where `--resume` takes only a session id) and the control
channel (rewind/fork/checkpoint subtypes all rejected by name). The owner
then pointed out the VS Code extension forks at arbitrary points over the
same stream-json I/O, and grepping the 2.1.238 bundle
(`~/.local/share/claude/versions/2.1.238`) on 2026-08-25 found the lever the
probes missed — spawn-time flags, `.hideHelp()`'d, the same pattern as
`--permission-prompt-tool`:

- `--resume-session-at <message id>` — "When resuming, only messages up to
  and including the chain entry with `<message.id>`" survive; a truncating
  resume.
- `--resume-drops-turn <message id>` — print-mode guard: declare the prompt
  uuid of the turn the truncation discards; the resume is refused on a
  mismatch (protection against a session that grew since you looked).
- The bundled SDK client passes both from `options.resumeSessionAt` /
  `options.resumeDropsTurn`, so the extension respawns rather than sending a
  control request.

Strings prove intent, not behavior. The run: take a multi-turn session (the
OW-yilabe scratch store at
`~/.claude/projects/-tmp-ow-yilabe-scratch-2WnWbD/` still exists, or make a
fresh two-turn scratch session), pick an early user message's `uuid` from
its store file, and respawn
`claude -p --model haiku --input-format stream-json --output-format
stream-json --include-partial-messages --resume <id> --resume-session-at
<uuid> --fork-session` with one trivial prompt. Confirm against the store:
new session id, new file truncated at the given message, parent untouched.
While there (one-visit spirit): probe the `--resume-drops-turn` mismatch
refusal, and pin whether truncation is inclusive or exclusive of the named
message — Pi's fork-at-user-message is **exclusive**
(`docs/MANUAL_TESTING.md`, OW-yudoni), so the adapter's `fork(entryId)`
mapping needs both semantics stated side by side.

Whatever the run shows, three recorded copies of the tip-only conclusion are
brought into line with it, per the retire-every-copy rule: the OW-yilabe
section of `docs/MANUAL_TESTING.md` (its checklist table row and its Fork
paragraph), OW-beripo's fork bullets (the first-cut bullet and the answers
bullet), and a dated correction paragraph appended to
`docs/work/closed/OW-yilabe.md` after its close note. If pre-tip fork works,
OW-beripo's scope moves from tip-only to full `listForkPoints`/`fork` via
respawn; if it refuses headless or behaves otherwise, that behavior is the
new recorded fact and OW-beripo's scope says exactly what is possible.

Done when the run's evidence sits in `docs/MANUAL_TESTING.md` with the exact
invocation, a fixture (`fork-at-message.jsonl` or the refusal capture) is
committed under `resources/fixtures/claude/`, and the three sites plus
OW-beripo's scope agree with the observed behavior.

**Fixed** in `65dc3c3`: pre-tip fork verified live on 2.1.238/Haiku —
`--resume <id> --resume-session-at <store-line uuid> --fork-session` truncates
inclusively at the named entry, semantically (the dropped turn is out of
context), with the parent file byte-identical and still no lineage marker.
`--resume-drops-turn` refuses any cut whose discarded range does not start
with the declared turn's prompt entry, so it cannot guard an arbitrary
`fork(entryId)` and OW-beripo says to skip it. Fixture
`fork-at-message.jsonl`; evidence in `docs/MANUAL_TESTING.md`'s OW-yilabe
section; all three copies of the tip-only conclusion corrected in place, and
OW-beripo's fork scope is now full `listForkPoints`/`fork`.
