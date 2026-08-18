---
name: execute
description: Land one OW- row from docs/work/open/. Pass an id (/execute OW-33) to work that row; with no id, summarize what is open and help pick one. Use when implementing an already-written work item, not when deciding what to build.
---

# Execution session

**One row per invocation.** Land it, hand it back to be tried, stop. Never move
on to another row on your own — picking is the user's, and trying the last fix
is how they decide what is next.

## Invoked with no id

Survey what is open:

```
rg --no-heading -N -H '^(# |kind: )' docs/work/open | sort -V
```

One row prints as two lines, its kind then its headline, both prefixed with the
path the id is read off. `sort -V` is what puts them in id order — the searcher
walks files in parallel and its own order is not stable run to run, and plain
sort puts `OW-10` before `OW-2`. Do not drop the pipe, and do not add
`--no-filename`: the path prefix is what `sort -V` sorts on.
`docs/TRACKING.md`, "Staying greppable", is the spec for this command — keep the
two identical — and carries the headline-only and `kind:`-filter variants plus
the evidence for every flag.

Then summarize, grouped so they can be chosen between: what each is, roughly
what it costs, what it unblocks or depends on. Open the handful of row files you
need in order to say that; the survey is there so you do not read all of them.
Then wait.

## Invoked with an id

1. **Check the row.** Rows were recorded by whoever found them and not
   re-verified since; OW-23 was stale enough to invert its own conclusion.
   Confirm against the source first, and say so if it has drifted.
2. **Dispatch.** One subagent, model chosen per row. Open by telling it to read
   `CLAUDE.md` — it does not inherit it. Then the row's grounding and intent
   inline: paths, symbols, the test invocation, what done looks like. Point it
   at `docs/work/open/OW-N.md` and nothing else under `docs/work/` — it works
   the row it was given and does not go shopping.

   **If it writes**, it gets its own worktree. Say outright that it commits on
   that worktree's own branch and cannot commit on `main`. Tell it to
   `git merge --ff-only main` before starting and to report the sha it started
   at — the harness cuts from `origin/main`, which this project never pushes
   to, so the worktree is stale by every commit since the last push.

   **If it only reads and reports** — a cold read of a row before you start it,
   an adversarial check of something already written — it gets no worktree, no
   branch and no commit, so there is no diff to review and nothing to
   cherry-pick. Closing the row in step 4 is unchanged. Its report is the whole
   output; act on it here. Say "read only, write nothing, commit nothing"
   outright, because the default shape above is the writing one.
3. **Review.** Read the diff yourself. No review subagents, and never
   `/code-review ultra` here — it has cost a full budget window. Green tests
   are not the finding. Look for work beyond what the row asked (the row is the
   scope — delete the extra), drift from the agreed spec where the row named
   one, and tests that pass without having been shown to fail first.
4. **Land.** `git cherry-pick` the subagent's commit — not `git merge`, history
   on `main` is linear. Then `git commit --amend` for whatever review changed;
   a bare cherry-pick lands the version review rejected. `bun run check`,
   `git worktree remove`, `git branch -D`. Then close the row:

   ```
   git mv docs/work/open/OW-N.md docs/work/closed/
   ```

   and append to that file, as its last body paragraph, `**Fixed** in <sha>:
   <evidence>` — the landed sha and what shows it works. No heading above it,
   no strikethrough anywhere, no `sha:` frontmatter field. The `git mv` is the
   status change; git records it as a rename, so the body keeps its history.
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
