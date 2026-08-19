# Tracking

How agentpane's work items are stored, and the record of the migration that
got them there.

> ⚠️ **Parts of this document are outdated as of 2026-08-17.** The migration it
> proposes **has happened**: work items are one file each under
> `docs/work/open/` and `docs/work/closed/`, landed in `7ece977`, `d82885f` and
> `5440377` and closed as OW-54 in `ef1403d`. The markdown tables in
> `WORKSTREAMS.md` and `CLOSED.md` that several sections below describe in the
> present tense **no longer exist**.
>
> Still current: "The format: Maildir-shaped work items", "Staying greppable",
> "Ids are drawn at random", "The `OW` prefix", and "Tooling" (OW-59 is
> genuinely still open). Everything else is a record of how the decision was
> reached and how the conversion was specified — accurate about the past, wrong
> about today, and marked section by section below. "Two clones can mint the
> same id" was superseded on 2026-08-18 by the id scheme that follows it.
>
> Expect this file to be retired or moved somewhere explicitly historical once
> the new storage has baked in.

This is **a separate project from the agent UI** that happens to live in the
same repo, because its subject is this repo's own bookkeeping. Nothing here
blocks or is blocked by the UI work. **The storage format below is decided**
(owner, 2026-08-17), and this document carries that decision rather than
`DESIGN.md`, which holds the agent UI's — mixing two projects' decision records
would muddy both, so there is no `D` number. The tooling on top of it is *not*
decided (OW-59), tracked under `docs/work/open/` like everything else.

## What exists now

> ⚠️ **Outdated as of 2026-08-17** — this describes the tables OW-54 deleted.
> Kept because the rest of the document argues against it. The subsection that
> follows it, "The `OW` prefix", is still current.

`WORKSTREAMS.md` holds a markdown table of open rows, `CLOSED.md` the same
table of closed ones. A row is one table line. Closing means striking through
each cell, appending `**Fixed** in <sha>: <evidence>`, deleting the line from
one file and inserting it in id order into the other.

That shape was chosen deliberately over adopting beads, on the grounds that
development is serialized and nothing needs assignees or concurrent claims. It
carried its own revisit condition — *"if the list starts wanting fields this
table cannot carry — dependency edges between rows, or who holds what"* — which
`WORKSTREAMS.md` **no longer states in those words**: that paragraph was
rewritten on 2026-08-17 to record instead that neither half is what fired. Do
not go looking for the sentence; the wording above is quoted from the version
this document was written against.

### The `OW` prefix

"Open work", from the heading the list was born under in `409cad6`
(2026-08-12), the commit that consolidated status and open items out of four
documents that had drifted into contradicting each other. No document has ever
expanded the abbreviation, which is why nobody remembers it.

Treat it as an opaque prefix rather than a claim about an item's state. Ids are
stable and never reused, so it cannot be renamed without touching every item,
every citation, and the commit history that references them — and under the
storage below a closed item lives at `closed/OW-50.md`, where the prefix would
actively mislead if it still meant anything.

The owner raised renaming it on 2026-08-17, wanting a prefix that generalises if
the tooling ever serves other projects. Measured the same day, because the cost
of a rename is the whole argument: **82 of this repo's 174 commit subjects name
an `OW-` id** — 47% of the history, at `97731f0` — and the published history
already holds most of them, so rewriting them is off the table. A rename orphans
every one of those permanently.

Outside the two row files, the durable half of the census is **65 citations in
code comments and test names across 29 files** under `src/`, `e2e/` and
`playwright.config.ts` — the half an earlier count here missed entirely, and the
one that does not move when a document is edited. The prose half is around 115
more across six files, most of it this document's own cross-references
(`MANUAL_TESTING.md` 23, `DESIGN.md` 8, `execute/SKILL.md` 2, `HANDOFF.md` 1,
`AGENTS.md` 1, **zero** in `README.md` and `author/SKILL.md`, and the rest
here). **That last figure counts the document stating it, so any edit to this
file invalidates it** — it went from 43 to 77 inside the session that wrote the
sentence. Take the file count and the code half as the measurement; treat the
prose total as an order of magnitude and recount if it matters.

Two things follow. **The migration does not make a later rename cheaper or
dearer**, so there is no now-or-never moment to force a decision at: today it
is a `sed` across the 37 files that carry an id (35 plus the two row files),
afterwards a scripted `git mv` across one file per row plus the same
`sed`. And **the generality the owner actually wants does not require
the rename at all** — it requires the tool not to care, which is an OW-59
question. This project keeps `OW-`, whose only real defect is that nobody
remembers what it stood for; a different project picks its own.

## What is and is not going wrong

> ⚠️ **Outdated as of 2026-08-17** — the case for migrating, measured against
> the tables while they still existed. The counts and the complaints are about
> storage that is gone; the reasoning is why the current format looks as it
> does.

Measured 2026-08-15 at 34 open and 18 closed rows; re-counted 2026-08-17 at 40
open and 27 closed, then 41 within the hour when OW-68 was filed out of the same
conversation, then **42 open and 27 closed** — 60KB and 76KB — when OW-69 was
filed out of the audit of this document. Seventeen rows in two days, and a count
that has now aged three times inside one day of being written down. That rate is
itself part of what follows, and it is why every figure in this document is
dated and none should be cited without recounting.

**Integrity is fine.** Re-audited 2026-08-17, this time across the whole repo
rather than just `docs/`: no id in both files, no gaps in 1..69, each of the 69
defined exactly once, every cited id resolving to a definition (checked over
`docs/`, `AGENTS.md`, `README.md`, both skills, `src/`, `e2e/` and
`playwright.config.ts` — the one unmatched string is `OW-007`, this document's
own padding example), and every closed row carrying a real commit sha. 69 rows,
hand-maintained, zero errors. Automating for *correctness* would solve a
problem this project does not have.

**Cost is not fine, and the reason outlived the premise it was argued on.** 35
of the last 40 commits touched only docs, nine of them titled `docs: close
OW-N with its sha and evidence`. A close is four to six tool calls of string
surgery against two files now 60KB and 76KB, and it is structurally a second
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

**Neither documented revisit condition is what fired.** They were "dependency
edges between rows, or who holds what." Edges did become prose (below), but
nothing is blocked on them. And nobody holds anything — the two machines are
partitioned by *role*, not racing for rows, so no assignee or
claim is wanted even now. The condition that actually bit — **one file, edited
from two clones that diverge for hours** — was not on the list. It is now.

**The container has outgrown the content.** Median open row is 86 words and the
five longest run 394-980, by `wc -w` over the Item cell at `97731f0` — state the
method, because two agents counting this differently on the same day disagreed
by 20%. One row is one physical line, with consequences: the table cannot be
scanned without truncating lines; editing a row's middle means anchoring on a
fragment of a 400-word line; changing one clause rewrites the whole line in the
diff, so row history is effectively lost; and cells cannot hold lists, code
blocks, or paragraphs, so rows with real structure (OW-18's two parts, OW-51's
five decisions) get flattened into run-on prose. Ordering is a convention with
nothing enforcing it — three rows were inserted in the wrong position on
2026-08-15 and moved by hand.

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

## The format: Maildir-shaped work items

One file per item, and **status is the containing directory**:

```
docs/work/
  open/OW-50.md
  closed/OW-23.md
```

Closing is `git mv` plus appending the close note. Frontmatter carries the
fields that vary (kind, where, `needs:` edges, and on close the sha); the body
is prose with headings, lists and code blocks available.

**What `kind:` may hold**, carried here from the table this format replaces,
with the pointers into that table rewritten and nothing else. Five kinds share
one corpus, because they share a lifecycle:

- **deferral** — review found it, judged it not worth blocking on. None is a
  defect in a path the milestone exercises.
- **defect** — observed or read as broken, and nothing depends on leaving it
  that way. The client-shell items are all of this kind.
- **question** — a decision nobody has made yet. When one settles the item
  closes and the decision goes in `DESIGN.md`, which is where the reasoning
  belongs.
- **unverified** — believed to work, never proven. Closing one means producing
  evidence, and the evidence goes in `MANUAL_TESTING.md`.
- **change** — a deliberate change to behaviour or presentation that nobody
  considers broken today, **a new feature included**. Decided, not yet built;
  the decision and who took it belong in the item, because there is no defect
  to rediscover it from. `feature` is not a sixth kind: it drifted into three
  items before a count caught it on 2026-08-17 (finding 3 below).

### The conversion spec, which has to be exact

> ⚠️ **Executed 2026-08-17 in `7ece977`.** A spec for reading table cells that
> no longer exist. Nothing here is a rule for writing a work item today — that
> is the parent section, "The format: Maildir-shaped work items".

This section is phase 1's whole specification, and its exactness is what makes
phase 1 a script rather than a fan-out: anything left to prose is something the
transform's author invents alone, and the equivalence check cannot arbitrate a
rule it was written from. A first attempt at this section gave one example and a
paragraph; a dry-run read on 2026-08-17 produced the artifacts from it and found
**twenty points it had to invent**, three of them introduced by the example
itself. Closing those twenty is what made the script possible. Phase 1 is
**transcription**: it changes the container and nothing else.

```
---
kind: <the Kind cell, verbatim, unquoted>
where: '<the Where cell, verbatim, in single quotes>'
---

# <the headline, one line, never wrapped>

<the rest of the Item cell, wrapped at 80 columns>
```

- **`where:` is always single-quoted, and the quotes are not optional.** 52 of
  the 69 Where cells begin with a backtick, which YAML forbids as the first
  character of a plain scalar (`Plain value cannot start with reserved
  character`, reproduced 2026-08-17), and four contain a `"`. No Where cell
  contains an apostrophe, so nothing needs escaping; if one ever does, double
  it. Keep the backticks and the full value — do not tidy it, shorten it, or let
  it wrap.
- **No field but `kind:` and `where:`.** Not `needs:` — dependency edges are
  prose today (OW-51 and OW-52 assume OW-50; OW-49 is "entangled with OW-24")
  and deriving them is judgement rather than transcription. Not `sha:` either,
  even on a closed row: four close notes name two shas, so there is no single
  value to put there, and the sha stays in the note text where its author put
  it. Both fields exist for whatever OW-59 wants; the migration does not
  populate them.
- **An item needing a live backend says so in the body, not in a field.**
  Neither CLI runs on the home server (`AGENTS.md`, "Evidence"), so an item
  whose evidence has to come from a live turn opens its body with exactly
  `**Work laptop:** needs a live Pi run.` — or Codex, or "Pi or Codex". One
  spelling, because the point of it is one grep:
  `rg -l '^\*\*Work laptop:\*\*' docs/work/open | sort -V`. It sits in the
  body rather than in frontmatter for the reason above, and first in the body
  because it decides whether to read the rest.
- **The headline is promoted, not copied.** If the Item cell opens with a `**`
  span, the headline is that span with the markers dropped and **everything else
  inside it kept** — code spans, dates, the trailing period, a second sentence.
  Otherwise it is the first sentence up to and including its period. Either way
  it leaves the body: it must not appear twice in the file. Exactly one line may
  begin with `# `.
- **The body is the remainder, verbatim, wrapped at 80 columns** at spaces that
  are already there. Promotion strands a leading connector on two rows (OW-54's
  body would open on an em dash, closed OW-41's on an open paren); dropping that
  one connector is the **only** deletion permitted, and the equivalence check
  allows it.
- **Insert no structure.** No `##` headings, no lists, no code blocks, no
  paragraph breaks of your own — even where a row obviously has parts. The
  format makes those available and rows should acquire them, but as later
  per-row edits with the reasoning in a commit, not silently during a migration
  whose only check is that the text survived.
- **Transcribe malformed markup as found.** Closed OW-46 carries a broken
  code-span nesting twice. Repairing it during transcription defeats the check;
  file it or fix it afterwards.
- **Closed rows:** delete every `~~`, keeping all the text between the marks,
  and the `**Fixed** in <sha>: <evidence>` note becomes the **final paragraph
  with no heading above it**. All 27 are regular enough for that to be
  mechanical.
- **Split each row into exactly four cells — id, kind, where, and everything
  after the third `|` as the Item. Do not split on every `|`.** Six rows carry
  a raw, unescaped `|` inside a code span: OW-38, OW-39, OW-44, OW-60, OW-61
  and OW-65, between one and four each, all of them TypeScript unions or a
  `||`. A naive split gives those rows five to eight cells and silently
  truncates the Item, which is the corruption this spec is least likely to
  survive by eye. Counted 2026-08-17.
- Unescape every `\|` to `|`, there being no table left to escape for. There
  are five, three of them inside OW-54's own survey commands; verified
  2026-08-17. One blank line after the closing `---`. The file ends with
  exactly one newline and carries no trailing spaces.

Two worked examples, which are the spec as much as the rules are. An open row
with a bolded lead claim and a backticked Where cell — OW-32 — becomes
`docs/work/open/OW-32.md`:

```
---
kind: deferral
where: '`src/server/adapters/codex/mapping.ts`'
---

# The Codex mapping handles item and content types DESIGN's mapping table does not name, so the table reads as a contract it is not.

`mapItem` (line 295) adds `imageGeneration` and `imageView` — both produce
output, neither is in `SILENT_ITEM_TYPES` — beyond DESIGN's ten-row table; ...
```

That headline is 143 characters and is not wrapped. A closed row with no bolded
lead, showing the strikethrough strip and the close note — OW-3 — becomes
`docs/work/closed/OW-3.md`:

```
---
kind: deferral
where: 'client workspace input'
---

# `setWorkspace` fires per keystroke, so typing an absolute path can enumerate every prefix of it.

Decide between debouncing and committing on blur.

**Fixed** in `26d104f` as part of OW-39: `setWorkspace` and the per-keystroke
server round-trip are gone entirely — the free-form input is replaced by a
workspace `<select>` derived from the already-listed sessions, and filtering is
now purely client-side over that in-memory list. No keystroke reaches the
server, so there is no prefix to enumerate.
```

Note what the second example does *not* do: no `sha:` field, no `## Fixed`
heading, and the headline keeps its code span and its trailing period.

Why the directory rather than a `status:` field:

- **The invariant becomes structural.** A row cannot be open and closed at
  once, or disagree with an index, because a file is in exactly one directory.
  Today a row's status *is* which of the two files its line sits in, enforced by
  remembering to move the line and to strike the cells — and OW-53 is what
  happened when a second place started restating it. Not to be confused with
  `AGENTS.md:49`, "Status lives in that file's Status table and nowhere else":
  that rule is about **build-slice** status, the table at the top of
  `WORKSTREAMS.md`, and it is untouched by anything here (see phase 2).
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
  Bodies are wrapped at eighty columns, so a headline that wrapped with them
  would yield half a title. (An earlier draft of this bullet said "every row
  today is prose wrapped at eighty columns", which is false of the tables — one
  row is one physical line — and it was the only sentence from which the
  body-wrapping rule could be inferred, so a dry run had to invent that rule. It
  is in the conversion spec now.) Body subheadings therefore start at `##`,
  which keeps `^# ` matching exactly once per file — confirmed against a body
  containing both a `##` subheading and a mid-sentence `# `.
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
a third — all three run on 2026-08-17 against the same kind of throwaway
prototype:

```
rg -N '^# ' docs/work/open | sort -V
rg --no-heading -N -H '^(# |kind: )' docs/work/open | sort -V
rg -l '^kind: defect' docs/work/open | sort -V
```

The second is the one that stands in for the scannable table: `sort -V` groups
both matches of an item together and orders them by id, so each prints as
kind-then-headline with no parser involved.

Three things about that output, reproduced against a throwaway prototype under
ripgrep 15.2.0 on 2026-08-17 because an earlier draft of this paragraph guessed
at all three. **Every one of these commands prints `path:content`, including the
first** — ripgrep prefixes the path per line whenever its output is not a
terminal, which is every piped use, so command 1 is a path-and-headline list
rather than the bare headline list it reads as. **That prefix is load-bearing,
not noise:** it is what `sort -V` sorts on, so it is what produces id order.
Add `--no-filename` and you get bare headlines sorted alphabetically by title,
which is the wrong order and silently so. And `-H --no-heading` on command 2 is
not redundant even though a pipe would do it: run interactively, ripgrep groups
matches under a filename *heading* instead of prefixing each line, and the two
flags force the per-line form either way. The within-item order — `kind:` before
the headline — is a `sort -V` collation artifact rather than something this
document reasoned out, so re-check it if the searcher ever changes.

Size, and it is a **simulation rather than a measurement**, there being no real
row files yet to measure: command 2's output over today's 42 open rows, with
each headline taken as the row's bolded lead claim, is **~7KB** against 60KB to
open the table. An earlier figure of ~4.3KB here was extrapolated from six short
synthetic rows and was presented as measured; it was not, and real headlines are
longer. The ratio is the claim worth keeping, not the number.

Ids stay unpadded (`OW-7`, not `OW-007`) because the filename *is* the id and
every citation in the repo is plain text; padding the filename alone would
make the two disagree. `sort -V` carries that cost instead, in one place.

The other `grep` case improves outright, and is an argument for this format the
rest of this document does not make: searching today's table for a term returns
the entire 400-word line it appears in, which cannot be read in a terminal.
Per-file, `grep -l` returns one **path** per matching item —
`docs/work/open/OW-63.md`, not `OW-63`. Three places in this document, and one
in OW-59, used to say it returns ids; the id has to be read off the path, which
costs nothing at a terminal and is a `basename` for anything parsing it.

### Two clones can mint the same id, and that is fine

> ⚠️ **Superseded 2026-08-18** by "Ids are drawn at random, because the writers
> are unbounded", below — "take the next id" is no longer the rule. Kept because
> its evidence is why the rule changed: both failure modes it records are real,
> and the silent one is why the id scheme changed rather than the process
> around it.

"Take the next id, never reuse one" was only ever safe because nothing ran
concurrently. Both machines can now read `OW-67` and write `OW-68`. Do not
design around this — no id partitioning by machine, no timestamps, no random
suffixes, all of which trade a rare cheap problem for a permanent ugly one.

Two reasons it stays cheap. Under one file per item a duplicate id is an
**add/add collision on one filename**, which git reports; in the table it is
two lines that both merge, silently. And a colliding id is by construction
*brand new*, which is the one case where the thing that makes ids unrenameable
— citations across the docs and the commit history — does not apply. Renaming
is a `git mv` and one headline edit. Resolve it when git says so.

**Two sessions in one clone are the case this does not cover, and there it is
silent.** Recorded 2026-08-18, when it happened: an authoring session read the
max id as 69 at 09:34, another session committed `OW-70.md` and `OW-71.md` to
the same working tree at 10:05 (`1e40fc4`), and the first session's redirects
overwrote both at 10:11 (`5addf08`). No collision was ever reported, because by
then the files were tracked and the write was an ordinary modification that
`git add` staged without comment — the add/add report above needs two *branches*
to meet, and these never diverged. Both items were recovered from `1e40fc4` and
renumbered, so the loss was repairable, which is the only reason this stays a
cheap problem rather than an argument for id partitioning. The remedy is a
non-clobbering write and re-reading the max id at write time, not a change to
the id scheme (`.claude/skills/author/SKILL.md`); whether tooling should own the
allocation instead is OW-59.

### Ids are drawn at random, because the writers are unbounded

> **Decided 2026-08-18 by the owner.** This supersedes the section above and
> keeps its evidence.

A sequential id needs a serialization point, and this repo has none between
pushes. That is not a discipline problem to be more careful about — it is the
scheme working as specified, with every session an independent allocator
reading a stale max. And the writers are not two machines, which is what the
section above assumed: they are every session in this clone, every session in
the other, and **every dispatched subagent, which works in its own worktree cut
from `origin/main`** (`.claude/skills/execute/SKILL.md`). That last one is what
rules out partitioning the id space. A worktree is created on demand, so there
is no moment at which a partition could be assigned to it, and a per-clone
stride would not reach it anyway — its `docs/work/open/` is a different
directory holding stale state.

So the name has to be chosen by the writer with no coordination at all. Two
forms do that: a slug derived from the headline, or a random string.

**Random won, on framing drift.** A slug is a second, unrenameable statement of
what an item is about, and headlines here get sharpened as understanding
improves — the slug cannot follow, so the corpus accumulates filenames that
misdescribe their items, which is the one failure a bare number avoided by
saying nothing at all. Against that, a slug is readable in a `git log --stat`,
in an `rg -l` result, and in conversation. **That readability is the whole of
what this decision bets against**, so the evidence that it was the wrong bet is
noticing you looked at a *filename* rather than a file and wanted to know what
it was.

Two arguments made on the way and withdrawn, recorded so they are not revived:
that a slug collision usefully signals a duplicate item — it mostly would not
fire, since two sessions describing the same item pick different words — and
that shorter ids tokenize more cheaply, which is true and irrelevant at this
scale. The pronounceable form was chosen for a different reason: a transposed
random string, `OW-kerata` for `OW-keraha`, looks exactly as plausible as the
original and nothing catches it.

**The form is `OW-` and three consonant-vowel syllables.** Eighteen consonants
— no `c`, `q` or `x`, ambiguous or awkward without a following `u` — times five
vowels is ninety per syllable, 729,000 in three. All lowercase, no digits,
nothing needing a shift key. Until `ow new` exists (OW-59), the generator is:

```
python3 -c "
import random
c, v = 'bdfghjklmnprstvwyz', 'aeiou'
print('OW-' + ''.join(random.choice(c)+random.choice(v) for _ in range(3)))
"
```

Draw collisions run about one in nine thousand against today's 78 items, which
is not why the writing step still checks both directories and creates
exclusively. The realistic duplicate is a model reusing a name it saw earlier in
its own context instead of running the generator, and that one is silent.

**The prefix stays `OW-`.** A second prefix for the new scheme was considered
and rejected the same day: two prefixes makes every search `(OW|AP)-`
permanently, and renaming the numeric items instead would orphan the **129 of
227 commit subjects** that name an `OW-` id at `3895125`. No operation needs to
know which scheme an id came from. "The `OW` prefix" above reached this for the
tooling question; this is the same answer for the same reason.

**The numeric items keep their names**, so the corpus is permanently mixed —
`OW-33.md` beside `OW-keraha.md`. Nothing is renamed, no history is rewritten,
every existing citation stays true. One consequence for the survey command in
"Staying greppable": `sort -V` still earns its keep, but only over the numeric
half, where it is what puts `OW-9` before `OW-10`. Over the drawn names it is
plain lexical order, which is arbitrary and only has to be stable.

## Migrating, in three phases

> ⚠️ **Done 2026-08-17** — phase 1 in `7ece977`, phase 2 in `d82885f`, phase 3
> in `5440377`, closed as OW-54 in `ef1403d`. Kept as the record of what was
> actually run and checked.

OW-54 is the row; this is how it runs, kept here rather than in the row because
a row is not the place for a procedure. The shape answers one constraint above
all: **a migration cannot be verified after its source is deleted.** So nothing
is deleted until the replacement has been checked against it.

Each phase ends at a commit that leaves the repo coherent, which is what makes
this resumable rather than one-shot. A session running out of room should stop
at a boundary and name it. A session that stops mid-phase should reset rather
than hand over half a phase.

**Phase 1 — generate alongside.** Write a file per row into
`docs/work/{open,closed}/`, both tables left exactly as they are. The tables are
still the source of truth and the new directory is inert, so every document
still tells the truth. **Count the rows yourself here and carry that number**;
the counts written into this document and into OW-54 were true when written and
drift with every row authored on the laptop.

**Carry it in the phase-1 commit message** (owner, 2026-08-17). The row permits
stopping at a phase boundary, so the tally has to survive a session boundary,
and it may not go into OW-54 itself or into a committed index. A commit message
is durable, immutable and findable with `git log --grep`, where a line in this
document is one more count that goes stale — and recounting at the start of a
later phase is *not* equivalent: the laptop can file a row between phases, so a
fresh count would legitimately differ from what phase 1 converted and the
done-when would fail for the wrong reason. Say in that message how many open and
closed rows were converted, and repeat the pair in OW-54's own close note.

**Write one transform script rather than farming rows out to subagents**
(owner, 2026-08-17, reversing the fan-out this section prescribed earlier the
same day). The fan-out was chosen while the conversion spec still had twenty
things an agent would have had to invent, and small contexts exercising
judgement was the right shape for that. The second dry run closed those twenty,
and the spec above is now deterministic — measured across all 69 rows on
2026-08-17, headline extraction resolves 48 by bolded lead span and 21 by first
sentence with **nothing left over**; no bolded lead carries a nested `**` to
defeat a non-greedy match; and no first-sentence headline terminates inside a
code span, `trust.json` in OW-25 being the near miss that the "period then
whitespace" rule declines correctly. Everything else in the spec is
substitution. A job with no judgement left in it is a script, and sixty-nine
agents doing substitutions is the thing this document's own cost argument
objects to.

Three things follow. The transform is re-runnable, so a failing equivalence
check is fixed once in one place and re-run over the whole corpus rather than
re-dispatched per row. There is no house style to hold across agents, so the
three-or-four-row worked-example batch that used to seed them is unnecessary —
the two examples in the spec are for whoever writes the script. And
`/execute`'s worktree and cherry-pick rules (`.claude/skills/execute/SKILL.md:23`
and `:36`) do not bind, because nothing that writes is dispatched at all; the
rehearsal of the dispatch mechanism this section used to require goes with them,
as does the risk of a model quietly tidying the markup the spec says to
transcribe as found.

**Then spot-check the output with one adversarial read-only subagent** (owner,
2026-08-17), which is where agent judgement still earns its keep: the
equivalence check tests the transform against its own idea of the transform, so
it is blind to a rule that is wrong in both. Hand it both tables and a sample of
the generated files — the long rows (OW-54, OW-59, OW-63 and OW-69 run 500-1000
words with nested bold and code spans), the six raw-pipe rows named in the spec,
and two or three closed ones — and ask it for text whose *meaning* changed,
rather than text that differs. It reads and reports; it writes nothing and
commits nothing, so there is no worktree and no cherry-pick. `execute/SKILL.md:26`,
"Do not send it to read WORKSTREAMS", is the one dispatch rule this crosses, and
deliberately: the tables are the ground truth it checks against. Dispatching
this one agent is pre-authorised. Reintroducing the fan-out is not.

Then check equivalence **mechanically**, before anything is deleted — this is
the last moment the check is possible. It cannot be a substring test: the
transform drops `~~`, unescapes `\|`, and promotes a `**bolded**` span into a
headline, so a literal comparison fails spuriously and whoever runs it will
weaken the check until it passes. Normalise both sides first, and the list is
longer than it looks: strip `~~` and `**`, unescape `\|`, collapse whitespace —
and **on the file side additionally strip the frontmatter block and the leading
`# `**, and allow the one stranded connector promotion drops. Those last three
exist only in the file, so a check implementing the first four alone fails all
sixty-nine and its reader starts weakening it, which is the trap this paragraph
is here to prevent. Then assert each row's text is present in its file, and
assert the Kind and Where cells against the frontmatter too — it is checking
`where:` that catches a mangled quote, on the 52 rows where the value cannot be
written unquoted at all. A throwaway script, not an eyeball: a corpus this size
is well past where reading catches a silent drop.

**Phase 2 — rewrite the process docs.** `AGENTS.md` and both skills describe the
old storage as procedure, and they are the loaded surface every session reads.
The "~40 lines per file" ceiling that used to govern them was **retired on
2026-08-17, not relaxed.** It was the agent's invention rather than the owner's,
calibrated to a token budget that has since expired; it appeared in no file in
this repo, only in an agent memory; and it was never true — measured that day,
`AGENTS.md` is 58 lines, `execute/SKILL.md` 59, `author/SKILL.md` 45. A ceiling
that nothing states and nothing meets is not a constraint.

**The ~60-line replacement is retired too, and there is now no line ceiling on
these files** (owner, 2026-08-17, asked because `execute/SKILL.md` was at 59 and
phase 2 adds to it): *"The ceiling has dubious value. We spend most of our
tokens on tool calls, not skill file reads."* That is the token argument gone at
the root rather than recalibrated, and it settles the question phase 2 would
otherwise have had to — **no existing rule has to leave `execute/SKILL.md` to
make room for the close procedure and the no-id survey.** Write what the storage
needs and let the file be as long as that takes. What survives is the discipline
the number was standing in for, now judged rather than counted: **a new rule
means an old one earns its place again**, because loaded prose competes for
attention even when it is free, and a rule nobody follows is worse than no rule
— which is what the 2026-08-13 restructure was for. One hazard the freed space
creates: phase 2 may now copy the survey commands into `execute/SKILL.md` rather
than citing them, which is two copies of a command that can drift. If it does,
this document is the spec and the skill follows it.

Coherent at the end: they describe storage that exists, and the stale tables are
still present with nothing pointing at them.

The loaded surface does not merely *mention* the old storage — it argues for it,
and four of the rules below actively contradict the format. Found by auditing
both skills and `AGENTS.md` against this document on 2026-08-17 (OW-69), and
listed so the phase-2 agent edits a known set rather than grepping for
`WORKSTREAMS`. The last entry is here to be **left alone**, which is the one a
grep would have got wrong:

- **`author/SKILL.md:28`, "There is no template, and none is coming."** The
  format does mandate a shape — a `# ` headline, flat `kind:` frontmatter — so
  the rule as written contradicts it, and its stated reason ("a row padded to
  satisfy a schema costs tokens on every read of the file") is a
  single-shared-file argument that dissolves when a read is one row. Keep the
  substance, which is still right: no required prose sections, nothing padded to
  fill a heading. Replace the reason, and say what the mandated shape is and
  where it is specified (this document's format section).
- **`execute/SKILL.md:23` and `:36`, "One subagent, its own worktree" and
  cherry-pick its commit.** Written for a code row and correct there (OW-57,
  OW-58). Phase 1's spot-check agent is the counter-example: it reads and
  reports, so it wants no worktree, no branch and no commit to pick. Phase 2
  decides whether the skill says so — a read-only subagent is a shape the rule
  as written does not admit.
- **`execute/SKILL.md:26`, "Do not send it to read WORKSTREAMS."** The reason
  was that reading it means loading 60KB of unrelated rows. That reason is gone;
  the intent — the subagent works the row it was given and does not go shopping
  — is not. Becomes: send it the row file, and nothing else from the corpus.
- **`execute/SKILL.md:40`, the close procedure.** Targets a file phase 3
  deletes. Becomes `git mv docs/work/open/OW-N.md docs/work/closed/` plus
  appending the `**Fixed** in <sha>: <evidence>` note as a body section, no
  strikethrough.
- **`execute/SKILL.md:15-16`, "Do not paste the table — closed rows carry long
  close notes and drown the open ones."** This sits in the "Invoked with no id"
  branch, which is exactly where phase 2's survey belongs, so an agent working
  from a list that omitted it would add the command and leave the stale sentence
  directly above it. The caution dies with the table; what replaces it is the
  survey.
- **`AGENTS.md:3-4`, `:42`, `:48`** — the three places that name
  `docs/WORKSTREAMS.md` or `docs/CLOSED.md` as where work lives.
- **`AGENTS.md:49`, "Status lives in that file's Status table and nowhere else"
  — keep the rule, but it needs a new antecedent.** It is about build-slice
  status, the table at the top of `WORKSTREAMS.md`, which survives phase 3
  intact; an earlier draft of this document quoted it as if it governed *row*
  status, which would have had a phase-2 agent delete a live rule, and
  `README.md:64` and `HANDOFF.md:11` both read it the way it is meant. The trap
  is that "**that file**" refers to `docs/WORKSTREAMS.md` as named on `:48` —
  the line being rewritten — so editing `:48` and leaving `:49` verbatim strands
  the pronoun. Name the file in the rule itself.

Both skills' YAML `description:` fields also name `docs/WORKSTREAMS.md`
(`author/SKILL.md:3`, `execute/SKILL.md:3`), as does `author/SKILL.md:13`.

**Phase 3 — delete.** Remove the Open work table from `WORKSTREAMS.md`, which
survives on its Status table, its three caller contracts, File ownership and the
shared interfaces. Delete `CLOSED.md` outright — it is a 10-line header plus the
table — carrying its one durable claim, that close notes are kept because they
are sometimes the grounding a later row needs, into wherever phase 2 describes
the new storage.

**Emptying the table orphans five things around it, and each needs saying where
it goes** — otherwise they are deleted with the table or left pointing at
nothing. One of them is inside the part of `WORKSTREAMS.md` that *survives*,
which is why it is the easiest to miss: `:15-16`, "**Open work** below holds
everything still outstanding", in the Status section's own preamble. It becomes
a pointer to `docs/work/open/`. The other four are inside the section being
emptied. `WORKSTREAMS.md`'s five-kind legend (`:124-139`) is the definition of
what `kind:` may hold, so it moves into this document's format section and
`author/SKILL.md` cites it there. "Adding a row costs a line: take the next id,
never reuse one" (`:144-145`) moves to `author/SKILL.md`, beside the
id-collision finding above. "Closing one moves it to `docs/CLOSED.md` with its
sha and the evidence" (`:145-146`) is superseded by phase 2's close procedure
and is deleted, not moved. The OW-26–31 provenance note (`:203-208`) is a fact
about seven specific rows, so it goes **into those seven files** — one line each
in `closed/OW-3.md` and `closed/OW-26.md` through `closed/OW-31.md` — which is
the only place it cannot go stale. Two more paragraphs are safe to delete
outright, and knowing that is the point of listing them: the "not re-verified
since, confirm against the source" rule (`:141-144`) is already
`execute/SKILL.md:20-22` verbatim in substance, and the Open-work intro
(`:117-122`) plus the experiment-concluded paragraph (`:148-156`) are history
this document already carries.

**Then check that paths resolve, not just ids.** OW-54's done-when checks that
every cited `OW-` id resolves to exactly one file, which is the wrong invariant
for this phase: what phase 3 breaks is *prose pointing at a table*, and no id
check sees it. These were found by hand on 2026-08-17, and none of the four
files the first four groups live in was in OW-54's Where — fix them and re-grep
rather than trusting this list to be complete:

- `docs/DESIGN.md:656-658` — "live in `WORKSTREAMS.md`'s Open work list" and
  "see `CLOSED.md`".
- `docs/MANUAL_TESTING.md:6-7` and `:359` — "its Open work list holds what is
  still outstanding", "Tracked as rows in `WORKSTREAMS.md`'s Open work list".
- `README.md:63-66` — "its Open work list is the only list of outstanding
  items", and this is the repo's one **markdown link** into the row storage.
  Note it carries zero `OW-` citations, so an id check reports it clean; the
  row's premise that every `OW-` citation is plain text is true and simply never
  covered path references like this one.
- `docs/HANDOFF.md:10-12` — "every outstanding item ... only in its Open work
  list"; `:255` also points at `WORKSTREAMS.md` for what it carries.
- **Inside the migrated rows themselves**, which is the easiest set to miss
  because they are the output rather than the input: `OW-24`, and closed
  `OW-41`, `OW-53` and `OW-58`, all cite `docs/CLOSED.md` or
  `docs/WORKSTREAMS.md` in their bodies. Rewrite the pointer, never the
  historical claim around it.

Two code comments (`src/server/adapters/pi/index.ts:2`,
`src/server/adapters/pi/reducer.test.ts:5`) cite `WORKSTREAMS.md` for File
ownership and the fixture-wording rule; both survive phase 3, so leave them.
`docs/superpowers/plans/` is a frozen record of a past plan and is deliberately
not updated.

**OW-54 closes as `docs/work/closed/OW-54.md`** (owner, 2026-08-17) — under the
storage it created, since the close procedure it replaces targets a file it
deletes. That makes its own close the first exercise of phase 2's new procedure,
which is the right place to find out whether that procedure is written clearly
enough to follow.

### Two details that decide how much judgement this needs

**Headlines are mostly mechanical, which was measured** rather than assumed.
Counted 2026-08-17: 23 of 42 open rows and 25 of 27 closed ones already open
with a bolded lead claim, which becomes the headline verbatim. The remaining 19
open rows are all early ones, none past OW-25 and **median 26 words, longest
55** — which is the number that matters here, not the 86-word corpus median
quoted further up, and an earlier draft of this paragraph used the corpus figure
by mistake. Their first sentence is already the claim ("A multi-file edit
flattens its hunks under the first path"), and four of them open with "Whether
...", which reads as a headline unchanged. So no row needs a headline
*invented*: extract the bolded span, else take the first sentence, then read the
result. The never-wraps rule bounds nothing about length — it forbids
hard-wrapping the line, not a long line.

**Closed rows lose their strikethrough.** `CLOSED.md` calls it a vestige of
closing in place, left as-is rather than rewritten. Under directory-as-status it
is a second encoding of status that can disagree with the directory — the OW-53
failure this format exists to make structural — and it would land as
`# ~~headline~~` in every survey. The `**Fixed** in <sha>: <evidence>` note
stays, as a body section. Note `git mv` has nothing to move during the
migration, since closed rows are lines inside a file rather than files; it is
what preserves history across a *future* close, which is why two directories
exist at all.

## Tooling, which is a separate item

The format above lands with none of this written. Closing becomes `git mv` plus
an append to a short file — already fewer moves than today's string surgery
against a 60KB file and a 76KB one — so the storage change collects most of the
measured cost win on its own. That makes these two items, not one: migrate the
format, live with it, and let that evidence decide which subcommand is worth
writing, in what order, and whether any of them is. Deciding both at once forces
a judgement about tooling before there is any experience of the storage to base
it on.

One real consequence of the split, worth seeing before choosing it: `ow list` is
what replaces the scannable table, so between the format landing and the tool
existing there is no *command named for the job*. There is still a single view —
the two-line survey above, simulated at ~7KB for 42 rows — so this interim is
milder than an earlier draft of this paragraph claimed, and the alternative that
draft offered (keep a generated index committed until `ow list` exists) is now
ruled out outright by finding 2 below. What `ow list` would actually buy over
the raw command is formatting and a memorable name, which is a smaller thing
than "no view at all" and is exactly why OW-59 waits for evidence.

Small, because the storage does most of the work:

- `ow new <kind> <where>` — skeleton file in `open/` under a drawn id. The
  draw itself is one line of `python3` (`author/SKILL.md`), so this buys the
  skeleton and nothing else; OW-59 records the day it stopped earning more.
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
   sufficient on its own. First, **beads does not fix the problem.** Its primary
   storage is a single JSONL, so add-vs-close from two clones lands in one hot
   file exactly as the table does — arguably worse, since a markdown row is at
   least human-mergeable at a glance. Adopting it would buy a dependency and a
   CLI learning curve on every cold agent (the reason recorded when this was
   deferred on 2026-08-13) and still leave conflicts to resolve by hand. Second,
   **the benefit beads is built for does not land here.** Agents claiming work
   autonomously, doing it and closing it presupposes an agent *selecting* work;
   agents here do not select, the owner does, by id, from a machine he is not
   implementing on. Not foreclosed: flat one-line frontmatter over one file per
   row is already a document store, so if agents ever do claim work, importing
   from it is more mechanical than from today's table, not less. The owner's
   2026-08-15 position — that a small bespoke tool is itself a hobby project
   worth having — stands, but it is no longer the load-bearing reason and should
   not be cited as one.
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
   Counted 2026-08-17, **before** the correction this finding goes on to
   describe: open rows were 20 `deferral`, 8 `question`, 5 `defect`, 4
   `unverified`, 3 `feature` and zero `change`. Re-counted after it, and after
   two more rows were filed: **21 `deferral`, 7 `question`, 6 `defect`, 4
   `change`, 4 `unverified`**, no `feature` left; closed are 23 `defect`, 3
   `change`, 1 `deferral`. The pre-correction census is the evidence and is kept
   for that reason — quoting it as the current one is the mistake to avoid.
   `feature` appeared in no legend, neither this document's nor
   `WORKSTREAMS.md`'s, while `change` — which *is* documented — had drifted to
   zero open rows. Read against its definition ("a deliberate change to
   behaviour or presentation that nobody considers broken today"), the three
   `feature` rows are `change` rows under a name authoring reached for
   naturally; they were corrected in the same change, and the legend now says
   so. The set does not need to grow. What it needed was for the drift to be
   visible, and under a single 60KB table it was not — in frontmatter a stray
   `kind:` is one `grep` away, which is what this question was really asking.
4. **What does migration cost? Known, and it is not the parsing.** The table is
   regular enough to parse, and **every `OW-N` citation in the repo is plain
   text** — re-checked 2026-08-17 across `docs/`, `README.md`, `AGENTS.md`, both
   skills, `src/` and `e2e/`, with a pattern for markdown links containing an id
   in either the text or the target; zero hits — so no id breaks in a move. Two
   things that claim does not cover, both of which cost real work: citations are
   not confined to `docs/` (65 of them sit in code comments and test names,
   above), and *path* references to the two files are a separate class that no
   id check sees, one of which is a genuine markdown link (`README.md:64`).
   Phase 3 carries the list. The rest of the real work is rewriting `AGENTS.md`
   and both skills to describe the new storage. One operational constraint found
   here rather than predicted: the migration rewrites every row, so it must run
   with **both clones in sync and nothing unpushed on either**. A laptop
   carrying new rows through it is the one merge that would genuinely hurt.
5. **Does `/author` still want the whole list in context? Both modes want
   cross-row access, and cross-row access is the thing this format improves
   most.** An earlier answer here was "no, authoring wants a headline index",
   and the owner corrected it on 2026-08-17 with two cases it ignored: authoring
   refers to other rows to find dependencies and to avoid filing a redundant
   one, and `/execute` invoked without an id is asked "what is on deck, what do
   you recommend". Both need to reach across every row.

   Prototyped the same day, then **re-derived against the real corpus on
   2026-08-17, which changed every number here**: the first pass ran against six
   short synthetic rows and each command happened to match exactly one of them,
   which read as a property of the format and is not one. **Redundancy:** `rg -l
   'copy' docs/work/open | sort -V` returns four paths today — OW-63, OW-64,
   OW-67 and OW-69 — not one, and it returns them as *paths*
   (`docs/work/open/OW-63.md`), not ids. The same search against the table
   returns the entire 400-word line the term appears in, which cannot be read in
   a terminal. That is the durable claim, and it does not need the match to be
   unique. **Reverse dependencies:** `rg -l 'OW-24' docs/work/open | sort -V`
   returns five — OW-24 itself, OW-42, OW-49, OW-56 and OW-69 — a lookup the
   table cannot do readably at all; note a row matches its own id, so the
   caller subtracts it. **Survey:** the two-line command above prints all 42
   rows as kind-plus-headline in id order, simulated at ~7KB against 60KB.

   So the corrected finding is the opposite of the one it replaces: the format
   serves all three access patterns better, and the only thing genuinely lost
   is reading every row's *full text* in a single file — which is not what
   either mode was doing it for, and half of which is `deferral` anyway. Two
   consequences fall out. The headline now carries the survey, so it has to be
   a real claim rather than a truncation (see OW-54). And picking a winner from
   a survey line may still mean opening three or four files, which is cheap and
   is the specific thing OW-59 should watch.

## Relationship to the UI work

OW-53 (the Status cell restating closed work) overlapped: its "restates what
CLOSED.md holds" half dissolves under this storage. **It was closed in `6f07f49`
before any of this landed**, which is the outcome this section used to recommend
— the rest of it never depended on the storage, because that cell describes
build slices rather than rows. Nothing here is waiting on it; it is cited as the
case that shows why a second copy of status drifts.
