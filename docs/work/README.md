# Legacy cards

This directory holds agentpane's legacy cards, retired on 2026-11-13 and read-only since.
Nothing dated after 2026-11-13 is in them: anything newer is in GitHub issues, in the repo's documents, or in git history, never here.

The cards cover work up to the card triage of 2026-10-31 to 2026-11-01, plus one closed on 2026-11-13.
That triage closed every open card, promoting what still wanted doing to GitHub issues (ark3/agentpane#3 to #35), and outstanding work has been tracked in GitHub issues since.
`TRIAGE.md` is the triage's own record, including what it left undecided.

An `OW-` id anywhere in the repo, in code comments and documents alike, names the file `closed/<id>.md`, such as `closed/OW-hutaki.md`; a card's id is its filename and not part of its text, so grepping `closed/` for an id finds the cards that cite it.
Work is now run through `card` on an ephemeral deck under `.git`, whose ids carry a different prefix, so an `OW-` id always means a legacy card.
