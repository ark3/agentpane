---
name: execute
description: Land one open work item from docs/work/open/. Pass an id (/execute OW-33) to work that item; with no id, summarize what is open and help pick one. Use when implementing an already-written work item, not when deciding what to build.
---

# Execution session

**One work item per invocation.** Land it, hand it back to be tried, stop.
Never move on to another on your own.

## Invoked with no id

Survey what is open:

```
rg --no-heading -N -H '^(# |kind: )' docs/work/open | sort -V
```

One item prints as two lines, its kind then its headline, both prefixed with
the path the id is read off. Keep this command identical to
`docs/TRACKING.md`, "Staying greppable".

That command is the listing. Do not `ls docs/work/open/` first.

Then summarize, grouped so they can be chosen between: what each is, roughly
what it costs, what it unblocks or depends on. Open the handful of files you
need in order to say that; the survey is there so you do not read all of them.
Then wait.

## Invoked with an id

1. **Check the item.** They were recorded by whoever found them and not
   re-verified since. Confirm against the source first, and say so if it has
   drifted.
2. **Dispatch.** One subagent, model chosen per item.

   **If it writes**, it gets its own worktree under `.worktrees/<id>` at the
   project root. The prompt opens with the worktree setup: `git merge --ff-only
   main`, report the sha it started at, then `bun install`. A failed
   fast-forward is the other clone's work, not staleness — stop and report,
   never force it. Tell it outright that it commits on that worktree's branch
   and cannot commit on `main`.

   Only then the reading: `CLAUDE.md` and the `AGENTS.md` it points at, neither
   inherited. Then the item's grounding and intent inline: paths, symbols, the
   test invocation, what done looks like. Point it at `docs/work/open/<id>.md`
   and nothing else under `docs/work/` — it works the item it was given and
   does not go shopping.

   **If it only reads and reports** — a cold read of an item before you start
   it, an adversarial check of something already written — it gets no worktree,
   no freshness step, no branch, and no commit. Its report is the whole output;
   act on it here. Say "read only, write nothing, commit nothing" outright.
3. **Review.** Read the diff yourself. No review subagents, and never
   `/code-review ultra` here — it has cost a full budget window. Green tests
   are not the finding. Look for work beyond what the item asked, drift from
   the agreed spec where it named one, and tests that pass without having been
   shown to fail first.
4. **Land.** `git cherry-pick` the subagent's commit. Then `git commit --amend`
   for whatever review changed. `bun run check`,
   `git worktree remove`, `git branch -D`. Then close the item:

   ```
   git mv docs/work/open/<id>.md docs/work/closed/
   ```

   and append to that file, as its last body paragraph, `**Fixed** in <sha>:
   <evidence>` — the landed sha and what shows it works. No heading above it,
   no strikethrough anywhere, no `sha:` frontmatter field.

   **The item's own conditionals fire at the close**, whichever way the answer
   came out. A "then, conditionally" clause naming another item, a doc, or a
   decision is part of landing this one. If the answer does not fit the branch
   as written — the condition was phrased over a predicted outcome that did not
   happen — that is a new item, never a skip.
5. **Hand back.** Say what changed and how to see it — what to run, what to
   look at, what would count as working. Then stop.

## Between items

The user tries it. Working means wait for the next pick. Wrong means a new
item, or amend this one and re-dispatch.
Something else surfaced means a new item, not this session's job. A new item
follows `.claude/skills/author/SKILL.md`: its id is **drawn, not chosen**, and
checked against `docs/work/open/` and `docs/work/closed/` before you write it.

Say when the conversation has grown long enough to be worth restarting.

## Never

- **Explore.** If the work needs reading what the item did not name, that is a
  subagent's job. Searching here is the failure mode.
- **Implement.** Edit only what review put in front of you, and only to fix
  what review found.
