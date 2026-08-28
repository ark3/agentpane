---
labels: [change]
---

# Cut the process prose over to card: retire both skills, rewrite AGENTS.md's tracking rules, mark TRACKING.md historical, and close OW-59.

`AGENTS.md`, `docs/TRACKING.md`, `.claude/skills/{author,execute}/`, plus whatever a procedure audit finds

Companion to OW-pisape, landing in the same visit — the owner chose a single
big-bang cutover (2026-08-25), and deliberately no `blocked-by:` edge: this
migration is hands-on, sequenced by the person running it.

What replaces what: card's served payloads — `card status`, `card workflow`,
`card author`, `card execute` — become the loaded procedure surface. The deck
declares itself public (OW-pisape's config), so card serves the public-deck
rendering: no privacy rules, no id-citation ban, and its lint gate stands
down; citing OW- ids in commit subjects stays as legal as the 129-of-227
convention needs. `/author` and `/execute` are deleted, not stubbed — their
jobs move to card's payloads wholesale (decided 2026-08-25). Keep in
`AGENTS.md` only what card cannot know: which repo facts bind sessions here
(the two-machine split, the evidence rules, `bun run check`), not procedure
card already serves. Where a card payload and a sentence here would state the
same rule, the sentence becomes a pointer; two copies drift.

The known edit set — audit before trusting it complete; the tell for the audit
is any doc stating tracking *procedure* rather than citing an id or a path:

- `AGENTS.md`: the work-items paragraph in the preamble; "Landing work"'s
  filing and closing bullets (id drawing moves from the python3 snippet to
  `card new`; closing moves to card's close procedure as `card workflow`
  states it); the `rg -l '^\*\*Work laptop:\*\*'` survey in "Evidence"
  becomes a `work-laptop` label filter; the "Sessions" section's two modes
  re-point from the skills to card's author and execute payloads.
- `.claude/skills/author/SKILL.md` and `.claude/skills/execute/SKILL.md`:
  deleted. Anything they carry that card's payloads do not — repo-specific
  rules like the worktree/cherry-pick shape for dispatched writers — moves to
  `AGENTS.md` rather than dying with the file; read both before deleting.
- `docs/TRACKING.md`: gets the retirement its own preamble promises — a note
  that the format it specifies is now read and written through card, that
  `kind:` lives on as a label (the five-kind legend stays the definition of
  the label set), and that the survey commands and id generator it teaches
  are superseded. The history stays; it is the record of why the storage has
  this shape, and card's redirect exists because of it.
- Per-clone setup, documented where the work laptop will find it on its next
  pull (`AGENTS.md` is the loaded surface, so there): install card — a
  checkout of the card repo, `bun install`, `src/card.ts` symlinked onto PATH
  as `card` — plus the three-line `.git/card/card-config.toml` from
  OW-pisape, written once per clone.

What does *not* change, stated so nobody greps it into scope: every `OW-` id
citation and every `docs/work/` path stays true — the corpus does not move
and no id is renamed — so `DESIGN.md`, `MANUAL_TESTING.md`, `HANDOFF.md`,
`WORKSTREAMS.md` and `README.md` stand except where the audit finds procedure
prose.

Then close OW-59 under the new tool — the first `card`-procedure close in
this repo, the same move OW-54 made when its own close was the first exercise
of the storage it created. The answer OW-59 waited for: the tool was built,
as `card`, a separate project (its repo's OW-59-descended brief carries the
two-tier design), and the subcommand question it held open is settled by
adoption rather than by an `ow` implementation. Its close note records that
and points here.

Done when:

- A cold session in this repo, reading `AGENTS.md` and what card serves and
  nothing else, files and closes a work item correctly — without the retired
  skills, the python3 generator, or `docs/TRACKING.md`.
- `rg -n 'ow list|/author|/execute|\^kind:' AGENTS.md docs README.md` and a
  read of the audit's findings show no committed doc teaching the old
  procedure as current.
- `docs/work/closed/OW-59.md` exists with its note, moved and noted through
  card's own procedure.
- The work laptop paragraph is followable verbatim: every command in it was
  run on the home server before the item closes.

**Fixed** in `24c9d83`: `AGENTS.md` keeps only what card cannot know, both
skills are deleted, `docs/TRACKING.md` is marked historical, and the three
other docs that stated retired procedure are corrected. OW-59 closed in
`1d21bcd`.

A completeness audit ran before any of it, as this item asked, and it found
the item's own "stands except…" list wrong in two places. `docs/WORKSTREAMS.md`
"How work gets done" named `/author` and `/execute` as where process rules
load — the one statement outside `AGENTS.md` of the whole procedure surface,
so the most likely thing to be read by someone who missed the cutover. And
`docs/MANUAL_TESTING.md`'s OW-58 section concluded that a dispatched worktree
is cut from the remote tracking ref, which `card worktree` falsifies as a
statement about dispatch: it cuts from the branch the main checkout is on.
That fact had three copies, in `MANUAL_TESTING.md`, `TRACKING.md` and
`AGENTS.md`, and all three moved in the one change — the case AGENTS.md's own
"retire **every** copy" rule exists for. The OW-58 measurement itself is kept:
it still records the Claude Code harness's own cutter, and the correction is
careful not to claim anything was re-measured.

**Six places where the skills and card's payloads disagreed rather than merely
differed**, decided rather than merged, and each written into `AGENTS.md` as a
visible decision so a reader who has just read the payload is not left thinking
one of the two is a mistake. To this repo: the authoring gate (discuss to
agreement before writing a card, against card's write-then-flag default —
the 2026-08-18 incident survives the skill that carried it); the close note's
`**Fixed** in <sha>` shape, against card's ticket-key advice, because there is
no ticket system here and the repo never squashes; and eighty-column bodies,
against card's one-sentence-per-line. To card: the worktree base; the
set-of-cards execution model, which lets a session close several unattended
where the skill mandated one per invocation; and the adversarial reader, which
card requires and the old skill's blanket ban on review subagents forbade —
only the `/code-review ultra` budget ban survives as repo-local.

The first done-condition was met by doing it rather than by asserting it. This
session filed **OW-dafebo** with `card new`, which drew the id, and closed
OW-59 with `card close --done` — both without the retired skills, the `python3`
generator, or `docs/TRACKING.md`. `card show`, `card status` and
`card list --open --label work-laptop` all serve correctly against the
converted corpus.

One gap, recorded rather than papered over: the setup paragraph's commands were
all run on the home server from a fresh clone, but the clone itself went over
HTTPS, because this sandbox remaps `/etc/ssh/ssh_config.d/` ownership to
`nobody` and ssh refuses it. The `git@github.com:` URL in the paragraph is the
form agentpane's own remote uses and is unexercised here. OW-gabemi is where
that paragraph gets followed verbatim on the machine it was written for.

**Correction, 2026-08-27, same day**, from the owner reviewing the six
decisions above: two of the three that went to this repo were wrong, and the
third was wrong in the other direction.
The authoring gate is gone — `card author`'s write-then-flag default stands,
because its "when the owner is present and still discovering what they want,
authoring is a conversation" clause already covers the 2026-08-18 incident, and
an override was a third copy of a rule that loads twice already.
The close-note section kept its convention and lost its argument: card's
ticket-key advice is conditional on the card having a ticket key, which none
here do, so there was never a disagreement to override — writing a rebuttal to
it broke the "refuting something nobody would have tried" rule two sections
below the place that states it.
The eighty-column body rule is **retired outright** rather than defended: card's
one-sentence-per-line is the rule now, in this repo as in card's own.
The owner's reason is that eighty columns began as a de facto habit and
accreted into a rule that made writers count characters for no reader's
benefit; it is recorded in the card repo, which is why a session reading only
this repo could not see it and defended the rule instead.
Landed in `953a25b`, which also retires the surviving copy in
`docs/TRACKING.md`, "Staying greppable".
