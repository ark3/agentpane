---
labels: [question]
---

# Whether the two `check` invariants are worth respecifying, and where they would run — the one sketched subcommand card did not ship.

Split out of OW-59 at its close (2026-08-27), because OW-59's done-when asked
for each sketched subcommand to be "either written or recorded as not wanted,
with the reason being something observed", and `check` is neither. Card
shipped `new`, `show`, `list`, `close`, `cmd`, `worktree`, `status`, `init`,
`lint-commit` and the three payload verbs; `check` was left out without a
recorded verdict, so this carries the undecided half rather than letting a
close note claim a decision nobody took.

The two invariants and what running them by hand actually showed, measured in
a triage session on 2026-08-19 and recorded in OW-59 under "What living
without the tool actually showed" — read it there rather than here:

- *Every cited id exists* produced four hits and four false positives, all of
  them ids appearing as **examples** inside the documents that describe the
  invariant. A naive implementation cries wolf on 100% of its output, so it
  needs a way to tell a citation from an illustration.
- *Every closed item carries a real sha* produced one violation and it is
  legitimate: `docs/work/closed/OW-74.md` was closed unbuilt and says so in
  its own text. There are two legitimate close shapes and the invariant as
  written in `docs/TRACKING.md`, "Tooling, which is a separate item", knows
  about one.

Card changes the second invariant's ground, which is the new thing to weigh.
`card close` now demands a disposition flag — `--done|--promoted|--declined
|--moot` — so "the work never happened" is recorded structurally instead of
being inferred from the absence of a sha. What the flag does *not* do is get
written into the file: `src/verbs/close.ts` in the card repo appends the
stdin note verbatim and records the flag nowhere on disk, so a checker still
cannot read a card's disposition back. Whether that is a defect in card or the
reason `check` should not exist is the question.

The tension OW-59 left sharper rather than resolved, and the reason this is a
question and not a change: `check` is the only verb that looks for a defect
nobody is looking for, which argues for it running automatically rather than
being typed — the repo precedent is `src/import-boundaries.test.ts`, which
fails the build and names your file. But automatic means repo-local, and card
is deliberately cross-project. A test in this repo that greps `docs/work/`
would resolve the tension by picking a side; so would a `card check` that
every consumer runs by hand.

Done when the invariants are either respecified and given a home — a test
under `src/` that goes red on a planted bad citation and green after, or a
verb in the card repo — or declined, with the reason being the false-positive
rate above rather than a prediction.
