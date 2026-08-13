---
name: execute
description: Land one OW- row from docs/WORKSTREAMS.md. Pass an id (/execute OW-33) to work that row; with no id, summarize what is open and help pick one. Use when implementing an already-written work item, not when deciding what to build.
---

# Execution session

**One row per invocation.** Land it, hand it back to be tried, stop. Never move
on to another row on your own — picking is the user's, and trying the last fix
is how they decide what is next.

## Invoked with no id

Summarize the open rows grouped so they can be chosen between: what each is,
roughly what it costs, what it unblocks or depends on. Do not paste the table —
closed rows carry long close notes and drown the open ones. Then wait.

## Invoked with an id

1. **Check the row.** Rows were recorded by whoever found them and not
   re-verified since; OW-23 was stale enough to invert its own conclusion.
   Confirm against the source first, and say so if it has drifted.
2. **Dispatch.** One subagent, its own worktree, model chosen per row. Open by
   telling it to read `CLAUDE.md` — it does not inherit it. Then the row's
   grounding and intent inline: paths, symbols, the test invocation, what done
   looks like. Do not send it to read WORKSTREAMS.
3. **Review.** Read the diff yourself. No review subagents, and never
   `/code-review ultra` here — it has cost a full budget window. Green tests
   are not the finding. Look for work beyond what the row asked (the row is the
   scope — delete the extra), drift from the agreed spec where the row named
   one, and tests that pass without having been shown to fail first.
4. **Land.** `bun run check`, commit, strike the row with its sha and evidence.
5. **Hand back.** Say what changed and how to see it — what to run, what to
   look at, what would count as working. Then stop.

## Between rows

The user tries it; their reaction is the finding. Working means wait for the
next pick. Wrong means a new row, or amend this one and re-dispatch. Something
else surfaced means a new row, not this session's job.

Say when the conversation has grown long enough to be worth restarting — a
fresh session costs less than a long one.

## Never

- **Explore.** If the work needs reading what the row did not name, that is a
  subagent's job. Searching here is the failure mode.
- **Implement.** Edit only what review put in front of you, and only to fix
  what review found.
