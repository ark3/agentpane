---
labels: [change]
---

# Convert every work item to card's file schema in one scripted big-bang: `kind:` and the Work-laptop marker become labels, `where:` moves into the body.

`docs/work/` — every file under `open/` and `closed/`

Decided by the owner 2026-08-25 and finalized 2026-08-27, planning in the card
repo: this repo's tracking moves onto `card`, the tool OW-59 waited for, built
as its own project in a sibling checkout rather than as `ow`. The corpus stays
exactly where it is — `docs/work/{open,closed}/`, in-tree and git-synced, so
the two-machine workflow is untouched — and card reads it there through a
per-clone redirect config (below). What has to change is the frontmatter:
card's parser accepts exactly two fields, `labels:` and `blocked-by:`, both
one-line inline lists, and hard-rejects any other field, so every file in the
corpus fails to parse today.

The mapping, decided:

- `kind: <k>` becomes `labels: [<k>]`. The five kinds survive verbatim as
  label values: change, defect, deferral, question, unverified.
- A file whose first body line matches `^\*\*Work laptop:\*\*` also gains the
  label `work-laptop` (spelling the owner's, 2026-08-27). The marker line
  itself stays: the label is the searchable boolean, the line still says which
  CLI the visit needs. Eight files carry it at the 2026-08-27 count.
- `where:` leaves the frontmatter. Its value — surrounding single quotes
  stripped, any doubled `''` undoubled, otherwise verbatim — becomes a body
  paragraph of its own, first in the body, except after the Work-laptop marker
  where one exists; the marker keeps the first line for the reason
  `docs/TRACKING.md` gives (it decides whether to read the rest).
- `blocked-by:` is never populated. Blocker prose in bodies stays prose
  (owner, 2026-08-27): card's blocked-by mechanically holds dependents shut,
  and arming that across ~41 open items sight-unseen is not this migration's
  business.

Like OW-54's phase 1, this is transcription — one script over the whole
corpus, no subagents, nothing else edited. Headlines, bodies, close notes and
every `OW-` citation stay byte-identical; the only changes to any file are the
frontmatter block and the one inserted `where:` paragraph. Make the script
skip a file already in the new shape, so it can re-run over items filed
between the conversion and the cutover landing.

Before it runs, two preconditions:

- Both clones in sync and nothing unpushed on either — TRACKING.md finding 4's
  constraint, back live: this rewrites every file, and a laptop carrying
  unconverted new items through it is the one merge that would genuinely hurt.
- The executing clone has `.git/card/card-config.toml`, hand-written (the
  owner declined `card init` support for redirects, 2026-08-25):

      prefix = "OW"
      deck = "../../docs/work"
      public = true

  The `deck` path resolves relative to `.git/card/`. `public = true` is load-
  bearing: it stands card's commit-lint gate down and makes card serve the
  public-deck rendering of its payloads, so nothing card teaches contradicts
  this repo's convention of citing OW- ids in commit subjects. The file is
  per-clone and deliberately unsynced; OW-kekavi carries documenting it for
  the other clone.

Done when:

- The mechanical equivalence check passes over every file, before anything
  else lands: strip the frontmatter block and the one inserted `where:`
  paragraph from the new file and it equals the old file byte-for-byte, and
  the per-label counts equal the old per-kind counts (count at run time — the
  2026-08-27 census of 108 files, 21/46/22/9/10 across
  change/defect/deferral/question/unverified, drifts with every filing).
- Every file parses through the real card CLI: `card show <id>` exits zero
  for every id, numeric (`OW-1`) and drawn (`OW-bovase`) alike, and
  `card status` reports the true open and closed counts.
- The commit message carries the tally — files converted per directory and
  per label — the way OW-54's phase 1 carried its row counts, and for the
  same reason: the count drifts, the commit does not.

OW-kekavi is the companion: it cuts the process prose over and lands in the
same visit, because between this item landing and that one the `^kind:`
survey commands in `AGENTS.md` and `docs/TRACKING.md` match nothing.
