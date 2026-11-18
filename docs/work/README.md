# Legacy cards

This directory holds agentpane's legacy cards, retired on 2026-11-13 and read-only since.
Nothing dated after 2026-11-13 is in them: anything newer is in GitHub issues, in the repo's documents, or in git history, never here.

The cards cover work up to the card triage of 2026-10-31 to 2026-11-01, plus one closed on 2026-11-13.
That triage closed every open card, promoting what still wanted doing to GitHub issues (ark3/agentpane#3 to #35), and outstanding work has been tracked in GitHub issues since.
The triage's own record, `TRIAGE.md`, was deleted on 2026-11-18 (#40) and is in git history; the declines it summarised are in the closed cards' own notes.

An `OW-` id anywhere in the repo, in code comments and documents alike, names the file `closed/<id>.md`, such as `closed/OW-hutaki.md`; a card's id is its filename and not part of its text, so grepping `closed/` for an id finds the cards that cite it.
A `card` deck, when one is used, is ephemeral and its ids carry a different prefix, so an `OW-` id always means a legacy card.

The cards cite documents that #40 retired on 2026-11-18.
`docs/HANDOFF.md`'s numbered findings are now "HANDOFF findings 1–49" at the end of `docs/MANUAL_TESTING.md`, and its environment sections are in `docs/ENVIRONMENT.md`.
`docs/WORKSTREAMS.md`'s code map and caller contracts are in `docs/DESIGN.md`'s Architecture; its Status table, `docs/TRACKING.md` and the `docs/superpowers/` documents are in git history only.
A decision cited as being in `docs/DESIGN.md` is a file of its own under `docs/decisions/`, reached from DESIGN's index.
