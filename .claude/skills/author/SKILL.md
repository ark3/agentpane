---
name: author
description: Run an authoring session — write or sharpen open work items under docs/work/open/ so a cold agent can read them and start coding. Use when deciding what to build next or fixing an underspecified item. This session does not touch code.
---

# Authoring session

Produce work items a cold agent can act on. **No code changes here.** Reading
widely is expected — this is the session that pays exploration once, so
execution sessions do not pay it again on every item.

Discuss each observation to agreement before writing its file. Answers to your
own questions are not agreement — they cover what you thought to ask, and the
item commits to everything else. Write it and land it once the user says that
observation is settled, then take the next one.

Then land it: a new `docs/work/open/<id>.md`, or an edit to the file of an
existing item, committed unless the user asks not to. Same for a material
revision to an item already on disk. An item that exists only in chat does not
exist.

## What a work item carries

**Grounding — the addresses that make reads targeted.** File paths, symbol
names, the exact test invocation, a pointer to the spec section or the earlier
work item whose close notes matter. Prefer a pointer to an explanation: skip
whatever the agent re-derives cheaply from a file you named.

**Intent — what done looks like**, what it is in service of, and which
specifics are load-bearing versus incidental. This is what prevents the two
characteristic cold-agent failures: working past the point, and complying with
a stale detail instead of noticing the item was wrong about it.

Three lines of each is normal.

## The shape the file must have

Mandated, and only this much: one-line `kind:` and `where:` frontmatter
scalars — `where:` always single-quoted, since most values open with a backtick
and YAML forbids that in a plain scalar — then exactly one `# ` line, the
headline, which never wraps, then the body wrapped at eighty columns with `##`
for any subheading. `docs/TRACKING.md`, "The format: Maildir-shaped work
items", is the spec; it also says why each rule is load-bearing rather than
stylistic, and its five kinds are the whole of what `kind:` may hold — there is
no sixth.

Adding an item is one new file in `docs/work/open/`, and **its name is drawn,
never chosen**. Not the next number: an id read minutes ago is not evidence
about the directory you are about to write into, and on 2026-08-18 that cost
two items — read at 09:34, `1e40fc4` filed OW-70 and OW-71 at 10:05, both
destroyed at 10:11 with nothing anywhere saying a word. Draw the name instead:

```
python3 -c "
import random
c, v = 'bdfghjklmnprstvwyz', 'aeiou'
print('OW-' + ''.join(random.choice(c)+random.choice(v) for _ in range(3)))
"
```

Check it against `docs/work/open/` *and* `docs/work/closed/`, and create the
file exclusively — `set -o noclobber` or `cp -n`. Not for the draw, which
collides about once in nine thousand: for the case where you reuse a name you
saw earlier in this conversation instead of running the generator, which is the
silent one. Numbered items keep their names and nothing is renamed, so the
corpus stays mixed on purpose. `docs/TRACKING.md`, "Ids are drawn at random",
is the spec and carries why.

**The headline is the item's lead claim, not a title.** It is the whole of what
the survey prints, so an item whose headline says "clipboard work" is invisible
to the person picking; "Copying a tool result copies the status pill with it" is
not.

Inside the body there is no template and none is coming: no required sections,
nothing padded to fill a heading. An empty heading is not free even when it is
cheap — a cold reader has to open it to find out it says nothing, and a section
that exists because the shape asked for it invites filler in place of grounding.

## The test for a finished work item

The next agent's first tool calls should be reads of things the item named. If
it opens with a codebase-wide grep, the item was underspecified.

## Success criteria

Observable, never descriptive: a test that fails before the change and passes
after, or a screenshot. Not "matches the description" — a spec checked only
against itself keeps its blind spots intact.

## Filing an item mid-work

Writing an item while you still have full context loaded: put the addresses in
now. You have them; the agent that picks it up starts cold.
