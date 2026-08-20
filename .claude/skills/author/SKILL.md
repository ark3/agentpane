---
name: author
description: Run an authoring session — write or sharpen open work items under docs/work/open/ so a cold agent can read them and start coding. Use when deciding what to build next or fixing an underspecified item. This session does not touch code.
---

# Authoring session

Produce work items a cold agent can act on. **No code changes here.** Read
widely enough to make the item specific.

Discuss each observation to agreement before writing its file. Do not treat
your own answers as agreement. Write and land the item once the user says that
observation is settled, then take the next one.

Then land it: a new `docs/work/open/<id>.md`, or an edit to the file of an
existing item, committed unless the user asks not to. Same for a material
revision to an item already on disk. An item that exists only in chat does not
exist.

## What a work item carries

**Grounding.** File paths, symbol names, the exact test invocation, and any
pointer to a spec section or earlier close notes that matter. Prefer pointers
over re-explaining details the next agent can re-derive cheaply from a file you
named.

**Intent — what done looks like**, what it is in service of, and which
specifics are load-bearing versus incidental.

**A conditional in "done when" is phrased over the decision it gates, not over
the outcome you expect.** OW-yudoni asked for a live answer and then wrote *"if
Pi cannot fork mid-turn, that is recorded in OW-hezidi's own file"*. The answer
came back "it can, but it kills the turn" — so the condition read false, the
follow-through never fired, and the decision it gated sat unmade until a review
caught it. *"Whatever the answer, record what it means for OW-hezidi"* fires
either way, and costs a word.

## The shape the file must have

Mandated, and only this much: one-line `kind:` and `where:` frontmatter
scalars — `where:` always single-quoted — then exactly one `# ` line, the
headline, which never wraps, then the body wrapped at eighty columns with `##`
for any subheading. `docs/TRACKING.md`, "The format: Maildir-shaped work
items", is the spec; its five kinds are the whole of what `kind:` may hold.

Adding an item is one new file in `docs/work/open/`, and **its name is drawn,
never chosen** — on 2026-08-18 `5addf08` took the next number from a listing
read minutes earlier and filed over the OW-70 and OW-71 that `1e40fc4` had
created six minutes before; recovered in `410b5cb`. Draw the name with:

```
python3 -c "
import random
c, v = 'bdfghjklmnprstvwyz', 'aeiou'
print('OW-' + ''.join(random.choice(c)+random.choice(v) for _ in range(3)))
"
```

Check it against `docs/work/open/` *and* `docs/work/closed/`, and create the
file exclusively — `set -o noclobber` or `cp -n`. `docs/TRACKING.md`, "Ids are
drawn at random", is the spec.

**The headline is the item's lead claim, not a vague title.** Make it specific
enough to stand on its own in the survey output.

Inside the body there is no template: no required prose sections, nothing
padded to fill a heading.

## The test for a finished work item

The next agent's first tool calls should be reads of things the item named. If
it opens with a codebase-wide grep, the item was underspecified.

## Success criteria

Observable, never descriptive: a test that fails before the change and passes
after, or a screenshot.

## Filing an item mid-work

Writing an item while you still have full context loaded: put the addresses in
now. The agent that picks it up starts cold.
