# Tracking

How agentpane's work items are stored, and a sketch of replacing that storage.

This is **a separate project from the agent UI** that happens to live in the
same repo, because its subject is this repo's own bookkeeping. Nothing here
blocks or is blocked by the UI work. **The storage format below is decided**
(owner, 2026-08-17), and this document carries that decision rather than
`DESIGN.md`, which holds the agent UI's — mixing two projects' decision records
would muddy both, so there is no `D` number. The tooling on top of it is *not*
decided (OW-59). Tracked as rows in `WORKSTREAMS.md` so the "everything
outstanding lives in that list" invariant stays true.

## What exists now

`WORKSTREAMS.md` holds a markdown table of open rows, `CLOSED.md` the same
table of closed ones. A row is one table line. Closing means striking through
each cell, appending `**Fixed** in <sha>: <evidence>`, deleting the line from
one file and inserting it in id order into the other.

That shape was chosen deliberately over adopting beads, on the grounds that
development is serialized and nothing needs assignees or concurrent claims.
`WORKSTREAMS.md` states its own revisit condition: *"if the list starts wanting
fields this table cannot carry — dependency edges between rows, or who holds
what."*

### The `OW` prefix

"Open work", from the heading the list was born under in `409cad6`
(2026-08-12), the commit that consolidated status and open items out of four
documents that had drifted into contradicting each other. No document has ever
expanded the abbreviation, which is why nobody remembers it.

Treat it as an opaque prefix rather than a claim about a row's state. Ids are
stable and never reused, so it cannot be renamed without touching every row,
every citation, and the commit history that references them — and under the
storage below a closed row lives at `closed/OW-50.md`, where the prefix would
actively mislead if it still meant anything.

The owner raised renaming it on 2026-08-17, wanting a prefix that generalises
if the tooling ever serves other projects. Measured the same day, because the
cost of a rename is the whole argument: **76 of this repo's 166 commit subjects
name an `OW-` id** — 46% of the history — and the repo is now pushed, so
rewriting them is off the table. A rename orphans every one of those
permanently. Outside the two row files there are a further ~79 citations, in
`TRACKING.md` (37), `MANUAL_TESTING.md` (24), `DESIGN.md` (8), the two skills
(6), `HANDOFF.md` (2) and `AGENTS.md` (2); those are mechanical.

Two things follow. **The migration does not make a later rename cheaper or
dearer**, so there is no now-or-never moment to force a decision at: today it
is a `sed` across eight files, afterwards a scripted `git mv` across 67 plus
the same `sed`. And **the generality the owner actually wants does not require
the rename at all** — it requires the tool not to care, which is an OW-59
question. This project keeps `OW-`, whose only real defect is that nobody
remembers what it stood for; a different project picks its own.

## What is and is not going wrong

Measured 2026-08-15 at 34 open and 18 closed rows; re-counted 2026-08-17 at
**40 open and 27 closed**, the two files now 48KB and 76KB. Fifteen rows in two
days. That rate is itself part of what follows.

**Integrity is fine.** An audit across both files found no id in both, no gaps
in 1..53, no cited-but-undefined id anywhere in `docs/`, `AGENTS.md` or
`README.md`, and every closed row carrying a real commit sha. Fifty-two rows,
hand-maintained, zero errors. Automating for *correctness* would solve a
problem this project does not have.

**Cost is not fine, and the reason outlived the premise it was argued on.** 28
of the last 40 commits touched only docs, eight of them titled `docs: close
OW-N with its sha and evidence`. A close is four to six tool calls of string
surgery against two files now 48KB and 76KB, and it is structurally a second
commit, because the sha does not exist until the fix is committed. This was
first argued as token cost at the end of long sessions, under a shared 5-hour
budget — a premise that expired on 2026-08-17 when the owner moved to a Max
account. The conclusion did not expire with it, because the objection was never
really scarcity: **spending an agent's turns on mechanical string surgery is
waste at any budget.** The bookkeeping is clean because it is done carefully,
and careful is what it costs.

**A single file, edited from two clones, conflicts every time.** Since
2026-08-17 the work is split across two machines: authoring happens on the
owner's work laptop, where a bug or a wanted feature is captured the moment it
is noticed, and implementation happens on a home server over Claude Code
remote. So one clone only *adds* rows and the other only *removes* them, which
ought to merge cleanly and does not. It conflicts on essentially every close,
because the id distribution is not uniform: new rows append at the tail of the
table, and the rows worth implementing *now* are the ones just authored — so
both roles write the same handful of lines. **The tail is a hot zone, and the
conflict rate therefore tracks how fast authoring goes, not how often closes
happen.** Resolution is mechanical every time, which is the tell: it is exactly
the work worth not doing by hand.

**Neither documented revisit condition is what fired.** `WORKSTREAMS.md` names
them as "dependency edges between rows, or who holds what." Edges did become
prose (below), but nothing is blocked on them. And nobody holds anything — the
two machines are partitioned by *role*, not racing for rows, so no assignee or
claim is wanted even now. The condition that actually bit — **one file, edited
from two clones that diverge for hours** — was not on the list. It is now.

**The container has outgrown the content.** Median row is 58 words; the top
five are 200-400. One row is one physical line, with consequences: the table
cannot be scanned without truncating lines; editing a row's middle means
anchoring on a fragment of a 400-word line; changing one clause rewrites the
whole line in the diff, so row history is effectively lost; and cells cannot
hold lists, code blocks, or paragraphs, so rows with real structure (OW-18's
two parts, OW-51's five decisions) get flattened into run-on prose. Ordering is
a convention with nothing enforcing it — three rows were inserted in the wrong
position on 2026-08-15 and moved by hand.

**Dependency edges are already prose.** OW-51 and OW-52 both assume OW-50 lands
first; OW-49 is "entangled with OW-24"; OW-33/34/35 are one cluster; OW-42
leans on OW-24 and OW-41. That is the first half of the documented revisit
condition, met — though met is not the same as binding, since a human picking
rows by id reads prose edges fine. The second half — who holds what — still has
not fired; see above for what did.

**Nothing here addresses staleness**, which is the failure that has actually
cost this project. OW-23 went stale enough to invert its own conclusion; the
Status cell once contradicted a paragraph twelve lines above it (OW-53). No
storage format detects a row whose claim about the code has aged out. Only
reading the source before acting on a row does, which `/execute` already
requires.

## The format: Maildir-shaped rows

One file per row, and **status is the containing directory**:

```
docs/work/
  open/OW-50.md
  closed/OW-23.md
```

Closing is `git mv` plus appending the close note. Frontmatter carries the
fields that vary (kind, where, `needs:` edges, and on close the sha); the body
is prose with headings, lists and code blocks available.

Why the directory rather than a `status:` field:

- **The invariant becomes structural.** A row cannot be open and closed at
  once, or disagree with an index, because a file is in exactly one directory.
  Today "status lives in the Status table and nowhere else" is a rule enforced
  by remembering it, and OW-53 is what happened when it stopped being.
- **Lock-free concurrency, which is the point of Maildir.** Written as a hedge
  against a future, and now the operative reason. Under the two-machine split
  above, adding a row creates `open/OW-68.md` while closing one renames
  `open/OW-67.md` and appends inside it — disjoint paths, so the merge is clean
  however long the two clones diverge. An earlier draft of this bullet claimed
  a shared table "conflicts on every concurrent close", which was too strong as
  stated: git merges distant single-line edits fine. It conflicts every time
  for the sharper reason above, that both roles write the tail. The correction
  is worth keeping, because a mechanism predicts the fix and a coincidence
  would not.
- **`git mv` preserves history.** A row keeps its body's history across the
  close, and ordinary line-level diffs come back.

Not carried over from Maildir: the `:2,S` filename flag suffix (every flag
change becomes a rename, and the syntax is unpleasant), the `tmp/`-then-rename
delivery protocol (git already provides atomicity), and the `new/`/`cur/`
split (no analogue worth having).

### Staying greppable, which is what makes the interim survivable

Until `ow list` exists the list *is* a `grep`, so the format has to earn that
rather than assume it. Three constraints, each measured against a throwaway
prototype on 2026-08-16 rather than reasoned about:

- **The headline is the first body line, `# `-prefixed, and never wraps.**
  Every row today is prose wrapped at eighty columns; a wrapped headline yields
  half a title. Body subheadings therefore start at `##`, which keeps `^# `
  matching exactly once per file — confirmed against a body containing both a
  `##` subheading and a mid-sentence `# `.
- **Frontmatter fields are one-line flat scalars.** No block scalars, or
  `^kind: ` stops matching and filtering by kind needs a parser.
- **The command must pin its own order, whatever the searcher.** Two
  independent reasons, both reproduced: lexicographic order is the wrong order,
  putting `OW-10` before `OW-2`; and every searcher on this machine walks files
  in parallel, so output order is not stable run to run. ripgrep 15.2.0 gave
  five different orders in five consecutive runs; ugrep 7.5.0 — what a bare
  `grep` resolves to in an agent shell, via an injected shell function — gave
  three in three. `rg --sort path` is a trap rather than a fix: it buys
  determinism and keeps the wrong order. Piping to `sort -V` gets both, and was
  stable across repeated runs under ripgrep, ugrep and GNU grep 3.12 alike.

So the interim list is one line, the fuller survey another, and the kind filter
a third — all measured 2026-08-17 against the same kind of throwaway prototype:

```
rg -N '^# ' docs/work/open | sort -V
rg --no-heading -N -H '^(# |kind: )' docs/work/open | sort -V
rg -l '^kind: defect' docs/work/open | sort -V
```

The second is the one that stands in for the scannable table. `-H` keeps the
filename, so `sort -V` groups both matches of a row together and orders rows by
id; each row then prints as kind-then-headline with no parser involved.
Measured at **~4.3KB for 40 rows**, against 48KB to open the table. The
within-row order is a `sort -V` collation artifact rather than something this
document reasoned out, so re-check it if the searcher ever changes — the same
caution the ordering bullet above earns.

Ids stay unpadded (`OW-7`, not `OW-007`) because the filename *is* the id and
every citation across the docs is plain text; padding the filename alone would
make the two disagree. `sort -V` carries that cost instead, in one place.

The other `grep` case improves outright, and is an argument for this format the
rest of this document does not make: searching today's table for a term returns
the entire 400-word line it appears in, which cannot be read in a terminal.
Per-file, `grep -l` returns the ids that matched.

### Two clones can mint the same id, and that is fine

"Take the next id, never reuse one" was only ever safe because nothing ran
concurrently. Both machines can now read `OW-67` and write `OW-68`. Do not
design around this — no id partitioning by machine, no timestamps, no random
suffixes, all of which trade a rare cheap problem for a permanent ugly one.

Two reasons it stays cheap. Under one file per row a duplicate id is an
**add/add collision on one filename**, which git reports; in the table it is
two lines that both merge, silently. And a colliding id is by construction
*brand new*, which is the one case where the thing that makes ids unrenameable
— citations across the docs and the commit history — does not apply. Renaming
is a `git mv` and one headline edit. Resolve it when git says so.

## Tooling, which is a separate item

The format above lands with none of this written. Closing becomes `git mv` plus
an append to a short file — already fewer moves than today's string surgery
against two 30KB ones — so the storage change collects most of the measured
cost win on its own. That makes these two items, not one: migrate the format,
live with it, and let that evidence decide which subcommand is worth writing,
in what order, and whether any of them is. Deciding both at once forces a
judgement about tooling before there is any experience of the storage to base
it on.

One real consequence of the split, worth seeing before choosing it: `ow list` is
what replaces the scannable table, so between the format landing and the tool
existing there is no *command named for the job*. There is still a single view —
the two-line survey measured above, at ~4.3KB for 40 rows — so this interim is
milder than an earlier draft of this paragraph claimed, and the alternative that
draft offered (keep a generated index committed until `ow list` exists) is now
ruled out outright by finding 2 below. What `ow list` would actually buy over
the raw command is formatting and a memorable name, which is a smaller thing
than "no view at all" and is exactly why OW-59 waits for evidence.

Small, because the storage does most of the work:

- `ow new <kind> <where>` — next id, skeleton file in `open/`.
- `ow close OW-N <sha|HEAD> <evidence>` — `git mv`, append the note. Resolving
  `HEAD` matters: the sha is only knowable after the fix commits.
- `ow list` — render the scannable table on demand.
- `ow check` — the two invariants that survive: every cited id exists, every
  closed row carries a real commit sha.

The evidence text stays typed by hand. Deciding what counts as evidence is the
part worth a human; placement is the part worth a script.

## What was open, and what settled it

All five questions this document carried settled on 2026-08-17, in the
conversation that produced the two-machine finding above. Kept as findings
rather than deleted: the reasons are the part worth not re-deriving.

1. **Build it, or adopt beads? Build it.** Two independent reasons, either
   sufficient on its own. First, **beads does not fix the problem.** Its
   primary storage is a single JSONL, so add-vs-close from two clones lands in
   one hot file exactly as the table does — arguably worse, since a markdown
   row is at least human-mergeable at a glance. Adopting it would buy a
   dependency and a CLI learning curve on every cold agent (the reason recorded
   when this was deferred on 2026-08-13) and still leave conflicts to resolve
   by hand. Second, **the benefit beads is built for does not land here.**
   Agents claiming work autonomously, doing it and closing it presupposes an
   agent *selecting* work; agents here do not select, the owner does, by id,
   from a machine he is not implementing on. Not foreclosed: flat one-line
   frontmatter over one file per row is already a document store, so if agents
   ever do claim work, importing from it is more mechanical than from today's
   table, not less. The owner's 2026-08-15 position — that a small bespoke tool
   is itself a hobby project worth having — stands, but it is no longer the
   load-bearing reason and should not be cited as one.
2. **Is the index committed? No, and now structurally.** It was recommended
   against on drift-hygiene grounds: a committed summary of the rows is a
   hand-maintained summary's twin and drifts the moment someone closes a row
   without regenerating, which is exactly OW-53. The two-machine finding makes
   it worse than untidy — a committed index would be **the one remaining file
   both clones write**, reintroducing precisely the conflict this format
   removes. The cost stands and is accepted rather than discovered: today the
   whole list opens in one file, including on a phone; afterwards it takes a
   command.
3. **Do kinds stay as they are? Yes, five — and the drift is the evidence.**
   Counted 2026-08-17: open rows are 20 `deferral`, 8 `question`, 5 `defect`, 4
   `unverified`, 3 `feature`; closed are 23 `defect`, 3 `change`, 1 `deferral`.
   `feature` appears in no legend, neither this document's nor
   `WORKSTREAMS.md`'s, while `change` — which *is* documented — had drifted to
   zero open rows. Read against its definition ("a deliberate change to
   behaviour or presentation that nobody considers broken today"), the three
   `feature` rows are `change` rows under a name authoring reached for
   naturally; they were corrected in the same change, and the legend now says
   so. The set does not need to grow. What it needed was for the drift to be
   visible, and under a single 48KB table it was not — in frontmatter a stray
   `kind:` is one `grep` away, which is what this question was really asking.
4. **What does migration cost? Known, and it is not the parsing.** The table is
   regular enough to parse, and every `OW-N` citation across the docs is plain
   text rather than a markdown link, so nothing breaks in a move. The real work
   is rewriting `AGENTS.md` and both skills to describe the new storage. One
   operational constraint found here rather than predicted: the migration
   rewrites every row, so it must run with **both clones in sync and nothing
   unpushed on either**. A laptop carrying new rows through it is the one merge
   that would genuinely hurt.
5. **Does `/author` still want the whole list in context? Both modes want
   cross-row access, and cross-row access is the thing this format improves
   most.** An earlier answer here was "no, authoring wants a headline index",
   and the owner corrected it on 2026-08-17 with two cases it ignored:
   authoring refers to other rows to find dependencies and to avoid filing a
   redundant one, and `/execute` invoked without an id is asked "what is on
   deck, what do you recommend". Both need to reach across every row.

   Prototyped the same day rather than argued. **Redundancy:** `rg -l 'copy'
   docs/work/open | sort -V` returns `OW-63.md` — an id. The same search
   against the table returns the entire 400-word line the term appears in,
   which cannot be read in a terminal. **Reverse dependencies:** `rg -l 'OW-24'
   docs/work/open | sort -V` returns `OW-56.md`, a lookup the table cannot do
   readably at all. **Survey:** the two-line command above prints all 40 rows
   as kind-plus-headline in id order, ~4.3KB against 48KB.

   So the corrected finding is the opposite of the one it replaces: the format
   serves all three access patterns better, and the only thing genuinely lost
   is reading forty rows' *full text* in a single file — which is not what
   either mode was doing it for, and half of which is `deferral` anyway. Two
   consequences fall out. The headline now carries the survey, so it has to be
   a real claim rather than a truncation (see OW-54). And picking a winner from
   a survey line may still mean opening three or four files, which is cheap and
   is the specific thing OW-59 should watch.

## Relationship to the UI work

OW-53 (the Status cell restating closed work) overlaps: its "restates what
CLOSED.md holds" half dissolves under this storage. The rest of it does not —
that cell describes build slices, not rows — so the row stands on its own and
should be fixed regardless of what happens here.
