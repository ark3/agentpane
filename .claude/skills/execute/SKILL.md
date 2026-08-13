---
name: execute
description: Run an execution session — pick the next OW- row, dispatch one subagent to implement it, review the diff directly, commit, repeat. Use when the job is landing work items that are already written, not deciding what to build.
---

# Execution session

Land written rows. Do not decide what to build here: if the next row is not
ready to hand to a cold agent, say so and stop rather than authoring it now.

## The loop

1. **Pick.** Read the Status table and the open rows in `docs/WORKSTREAMS.md`.
   Take the top unblocked row. Say which, in one line.
2. **Dispatch.** One subagent, its own worktree, model chosen per row. Open the
   prompt by telling it to read `CLAUDE.md` — it does not inherit it. Then the
   row's grounding and intent inline: paths, symbols, the test invocation, what
   done looks like. Do not send it to read WORKSTREAMS. Rows too small to
   justify a cold start get batched into one dispatch, not done here.
3. **Review.** Read the diff yourself. No review subagents, and never
   `/code-review ultra` here — it has cost a full budget window.
4. **Land.** `bun run check`, commit, strike the row with its sha and the
   evidence: `~~**OW-26** ...~~ **Fixed** in <sha>; pinned by <test>,
   confirmed failing first.`

## Keeping the session short

Your context is re-sent on every turn, so it is the expensive one.

- **Do not explore.** If the work needs reading anything the row did not name,
  that is a subagent's job. Searching in this session is the failure mode.
- **Do not implement.** Edit only files the review already put in front of you,
  and only to fix what review found. Anything larger goes back out.
- **Stop after three landed rows.** Give the count after each. Stop earlier if
  two reviews running have sent work back.
- Work discovered along the way becomes an `OW-` row, not this session's job.

## What review is looking for

Green tests are not the finding.

- Work beyond what the row asked. The row is the scope; delete the extra.
- Drift from the agreed spec, where the row named one.
- Tests that pass without having been shown to fail first.
