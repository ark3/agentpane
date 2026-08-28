---
kind: change
where: '`AGENTS.md`, `docs/TRACKING.md`, `.claude/skills/{author,execute}/`, plus whatever a procedure audit finds'
---

# Cut the process prose over to card: retire both skills, rewrite AGENTS.md's tracking rules, mark TRACKING.md historical, and close OW-59.

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
