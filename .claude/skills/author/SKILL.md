---
name: author
description: Run an authoring session — write or sharpen OW- rows under docs/work/open/ so a cold agent can read them and start coding. Use when deciding what to build next or fixing an underspecified row. This session does not touch code.
---

# Authoring session

Produce rows a cold agent can act on. **No code changes here.** Reading widely
is expected — this is the session that pays exploration once, so execution
sessions do not pay it again on every row.

When you add or materially revise `OW-` rows, land that docs change — a new
`docs/work/open/OW-N.md`, or an edit to the file of an existing row — and commit
it unless the user asks not to. A row that exists only in chat does not exist.

## What a row carries

**Grounding — the addresses that make reads targeted.** File paths, symbol
names, the exact test invocation, a pointer to the spec section or the earlier
`OW-` row whose close notes matter. Prefer a pointer to an explanation: skip
whatever the agent re-derives cheaply from a file you named.

**Intent — what done looks like**, what it is in service of, and which
specifics are load-bearing versus incidental. This is what prevents the two
characteristic cold-agent failures: working past the point, and complying with
a stale detail instead of noticing the row was wrong about it.

Three lines of each is normal.

## The shape the file must have

Mandated, and only this much: one-line `kind:` and `where:` frontmatter
scalars — `where:` always single-quoted, since most values open with a backtick
and YAML forbids that in a plain scalar — then exactly one `# ` line, the
headline, which never wraps, then the body wrapped at eighty columns with `##`
for any subheading. `docs/TRACKING.md`, "The format: Maildir-shaped rows", is
the spec; it also says why each rule is load-bearing rather than stylistic, and
its five kinds are the whole of what `kind:` may hold — there is no sixth.

Adding a row is one new file in `docs/work/open/`: take the next id, never
reuse one. Two clones can both take it, which is fine and is not designed
around — git reports the add/add collision on the filename, and the fix is a
`git mv` plus one headline edit (`docs/TRACKING.md`, "Two clones can mint the
same id").

**The headline is the row's lead claim, not a title.** It is the whole of what
the survey prints, so a row whose headline says "clipboard work" is invisible to
the person picking; "Copying a tool result copies the status pill with it" is
not.

Inside the body there is no template and none is coming: no required sections,
nothing padded to fill a heading. An empty heading is not free even when it is
cheap — a cold reader has to open it to find out it says nothing, and a section
that exists because the shape asked for it invites filler in place of grounding.

## The test for a finished row

The next agent's first tool calls should be reads of things the row named. If
it opens with a codebase-wide grep, the row was underspecified.

## Success criteria

Observable, never descriptive: a test that fails before the change and passes
after, or a screenshot. Not "matches the description" — a spec checked only
against itself keeps its blind spots intact.

## Filing a row mid-work

Writing a row while you still have full context loaded: put the addresses in
now. You have them; the agent that picks it up starts cold.
