# Tracking

How agentpane's work items are stored, and a sketch of replacing that storage.

This is **a separate project from the agent UI** that happens to live in the
same repo, because its subject is this repo's own bookkeeping. Nothing here
blocks or is blocked by the UI work. It is a sketch, not a decision: no `D`
number, and no agent should act on it without the owner saying so. Tracked as
one row in `WORKSTREAMS.md` so the "everything outstanding lives in that list"
invariant stays true.

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
storage sketched below a closed row would live at `closed/OW-50.md`, where the
prefix would actively mislead if it still meant anything.

## What is and is not going wrong

Measured 2026-08-15, at 34 open and 18 closed rows.

**Integrity is fine.** An audit across both files found no id in both, no gaps
in 1..53, no cited-but-undefined id anywhere in `docs/`, `AGENTS.md` or
`README.md`, and every closed row carrying a real commit sha. Fifty-two rows,
hand-maintained, zero errors. Automating for *correctness* would solve a
problem this project does not have.

**Cost is not fine.** 28 of the last 40 commits touched only docs, eight of
them titled `docs: close OW-N with its sha and evidence`. A close is four to
six tool calls of string surgery, and it happens at the end of an execute
session — when the conversation is longest and every turn re-sends the most
context. It is also structurally a second commit, because the sha does not
exist until the fix is committed. The bookkeeping is clean because it is done
carefully, and careful is what it costs.

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
condition, met. The second half — who holds what — has not fired: development
is still serialized.

**Nothing here addresses staleness**, which is the failure that has actually
cost this project. OW-23 went stale enough to invert its own conclusion; the
Status cell once contradicted a paragraph twelve lines above it (OW-53). No
storage format detects a row whose claim about the code has aged out. Only
reading the source before acting on a row does, which `/execute` already
requires.

## The sketch: Maildir-shaped rows

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
- **Lock-free concurrency, which is the point of Maildir.** Two agents in two
  worktrees closing two different rows touch two different files, so there is
  nothing to conflict. A single shared table conflicts on every concurrent
  close — precisely the failure that would otherwise force this change later,
  under worse conditions.
- **`git mv` preserves history.** A row keeps its body's history across the
  close, and ordinary line-level diffs come back.

Not carried over from Maildir: the `:2,S` filename flag suffix (every flag
change becomes a rename, and the syntax is unpleasant), the `tmp/`-then-rename
delivery protocol (git already provides atomicity), and the `new/`/`cur/`
split (no analogue worth having).

### Tool surface

Small, because the storage does most of the work:

- `ow new <kind> <where>` — next id, skeleton file in `open/`.
- `ow close OW-N <sha|HEAD> <evidence>` — `git mv`, append the note. Resolving
  `HEAD` matters: the sha is only knowable after the fix commits.
- `ow list` — render the scannable table on demand.
- `ow check` — the two invariants that survive: every cited id exists, every
  closed row carries a real commit sha.

The evidence text stays typed by hand. Deciding what counts as evidence is the
part worth a human; placement is the part worth a script.

## Open questions

1. **Build it, or adopt beads?** The sketch above converges on roughly what
   beads is, which makes this a live comparison rather than the settled thing
   an earlier draft of this reasoning assumed. Bespoke buys a ~100-line tool
   with no dependency and full control of the format; beads buys a dependency
   plus a query layer and a real dependency graph, already written. The owner's
   position on 2026-08-15 was that a small bespoke one is itself a hobby
   project worth having, which is a legitimate reason and should be recorded as
   the reason if that is the choice.
2. **Is the index committed?** Recommendation: no. A committed summary of the
   rows is a hand-maintained summary's twin and drifts the moment someone
   closes a row without regenerating — which is exactly OW-53. `ow list` prints
   it instead. The cost is real and should be acknowledged rather than
   discovered: today the whole list opens in one file, including on a phone;
   afterwards it takes a command.
3. **Do kinds stay as they are?** Five today (deferral, defect, question,
   unverified, change). In frontmatter they are cheap to filter on, which may
   argue for more of them, or for splitting kind from priority.
4. **What does migration actually cost?** The table is regular enough to parse,
   and every `OW-N` citation across the docs is plain text rather than a
   markdown link, so nothing breaks in a move. The real work is rewriting
   `AGENTS.md` and both skills to describe the new storage.
5. **Does `/author` still want the whole list in context?** Authoring wants to
   see everything open; executing wants exactly one row and currently reads a
   34KB file to get it. One-file-per-row serves the second case directly and
   the first through `ow list`.

## Relationship to the UI work

OW-53 (the Status cell restating closed work) overlaps: its "restates what
CLOSED.md holds" half dissolves under this storage. The rest of it does not —
that cell describes build slices, not rows — so the row stands on its own and
should be fixed regardless of what happens here.
