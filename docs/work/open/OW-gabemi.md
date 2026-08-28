---
labels: [change, work-laptop]
---

# Set the work laptop up for card: install the tool, write that clone's deck config, and verify the deck serves there.

**Work laptop:** needs the machine itself — one visit, after the cutover
lands there.

the work laptop's agentpane clone — its `.git/card/` and PATH, nothing in this repo

Filed 2026-08-27 alongside OW-pisape and OW-kekavi, for the half of the
migration only that machine can do. Runs strictly after both have landed
*and been pulled* on the laptop; by then the skills are gone, so this item
is executed under card's own workflow — `card status` in the clone is the
procedure, not `.claude/skills/`.

The steps are not restated here: OW-kekavi lands a per-clone setup paragraph
in `AGENTS.md` (install card from a checkout of its repo, `bun install`,
symlink `src/card.ts` onto PATH as `card`, plus the three-line
`.git/card/card-config.toml` with the deck redirect and `public = true`),
and that paragraph is the single copy to follow. This item is the trip
tracker: it exists so the visit happens, one visit does all of it, and what
actually happened on that machine gets recorded. If the paragraph and this
machine disagree — a missing `bun` or `rg`, a path that resolves
differently — following the machine and fixing the paragraph in the same
change is the job, not an excuse to stop.

Done when, all on the laptop:

- Every command in the `AGENTS.md` setup paragraph has been run there
  verbatim, or the paragraph was corrected to what actually worked and the
  correction committed.
- `card status` in the laptop clone reports the same open and closed counts
  as the home server at the same commit, and serves the public rendering —
  no privacy rules, no id-citation ban.
- `card show OW-1` and `card show` on any drawn id both parse there.
- The close note names the tool versions that mattered (bun, and the card
  checkout's commit) and any deviation from the paragraph, and the close
  itself goes through card's close procedure — this machine's first.
