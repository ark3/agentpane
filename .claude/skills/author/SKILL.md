---
name: author
description: Run an authoring session — write or sharpen OW- rows in docs/WORKSTREAMS.md so a cold agent can read them and start coding. Use when deciding what to build next or fixing an underspecified row. This session does not touch code.
---

# Authoring session

Produce rows a cold agent can act on. **No code changes here.** Reading widely
is expected — this is the session that pays exploration once, so execution
sessions do not pay it again on every row.

## What a row carries

**Grounding — the addresses that make reads targeted.** File paths, symbol
names, the exact test invocation, a pointer to the spec section or the earlier
`OW-` row whose close notes matter. Prefer a pointer to an explanation: skip
whatever the agent re-derives cheaply from a file you named.

**Intent — what done looks like**, what it is in service of, and which
specifics are load-bearing versus incidental. This is what prevents the two
characteristic cold-agent failures: working past the point, and complying with
a stale detail instead of noticing the row was wrong about it.

Three lines of each is normal. There is no template, and none is coming — a row
padded to satisfy a schema costs tokens on every read of the file.

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
