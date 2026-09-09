---
labels: [question]
---

# Whether `docs/TRACKING.md` stays, and whether the hard-wrapped older docs get reflowed, is nobody's decision yet

Two documentation questions from the cold read of 2026-09-09, neither of which the reader can settle.

`docs/TRACKING.md` is 993 lines that declare themselves historical in their own header, "no part of this document is normative now".
Nothing outside `docs/work/` links to it; `rg TRACKING` hits itself, OW-dafebo, and five closed cards.
The choices are to keep it as the migration record it says it is, to cut it down to the part OW-dafebo still needs, or to delete it and let git history hold it.

`AGENTS.md`, "Documentation", requires one sentence per line and no column wrap.
`README.md`, the sections of `docs/MANUAL_TESTING.md` written before 2026-08-27, `docs/TRACKING.md`, and both `resources/*/README.md` are hard-wrapped.
Reflowing them is mechanical and makes every line of those files show up in `git blame` under one commit; leaving them means the rule reads as aspirational to anyone who opens README first.

## Done when

The decision on each is recorded: TRACKING's fate in its own header or in the commit that removes it, and the reflow either done or the exemption named in the AGENTS.md sentence that states the rule.
