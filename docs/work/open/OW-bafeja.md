---
labels: [change, browser-testing]
---

# GitHub Actions has run `bun run check` green since 2026-08-12, so the browser suite has no job and four documents argue from a repo that has no CI.

`.github/workflows/ci.yml` has existed since `0d39207` (2026-08-12).
It runs `bun install --frozen-lockfile` then `bun run check` on every push to `main` and every pull request, and nothing else.
Probed 2026-09-01: `curl -s "https://api.github.com/repos/ark3/agentpane/actions/runs?per_page=5" | jq '.total_count, [.workflow_runs[] | {conclusion, head_sha}]'` reports 49 runs and `"success"` on `fd28016`, the deck's current tip.
The same API reports `"visibility": "public"`, so Actions minutes on GitHub's standard runners are free and unmetered; a second job costs wall clock and nothing else.

## The premise that is false

Four places assert or assume this repo has no CI, and every one of them was written while that workflow was already green.

- `docs/work/closed/OW-49.md`, close note: "An alias or environment flag would not create a gate on a repo with no CI; when CI exists, it should run both commands as separate jobs." It closed 2026-08-28, a day CI ran green twice.
- `docs/DESIGN.md`, "Testing strategy": "A future CI setup should run both commands as separate jobs."
- `docs/work/open/OW-24.md`, last line: the same "a future CI setup" sentence.
- `AGENTS.md`, "Commands": "it needs a browser, so nothing runs it for you (OW-49)."

OW-49's decision survives untouched: `test:browser` stays outside `bun run check`, which remains the fast browser-free local gate.
What does not survive is the reasoning underneath it and the deferral of the second job to a future that had already arrived.
Retire the premise at every copy in the same change, under AGENTS.md's "Evidence" rule that a correction filed only where the new work happens reaches nobody.

## The job

Add a second job to `.github/workflows/ci.yml` running `bun run test:browser`, sibling to `check` rather than downstream of it, so a browser failure and a unit failure are distinguishable without opening either.
It needs the Chromium binary a developer's machine already has: `bunx playwright install --with-deps chromium` before the test step, with `@playwright/test` already at `^1.62.1` in `devDependencies`.
`playwright.config.ts` starts its own Vite server on port 5199 with `reuseExistingServer: true` and `--strictPort`, so the job needs no service container and no separate build step.
Whether to cache the browser download is incidental at 11 tests; get it correct first.

## Done

A run of the browser job is observed green on GitHub against a real commit, not inferred from the YAML — a Playwright job that cannot find its browser fails only on the runner, so reading the file proves nothing.
The job is also watched going red once, which a scratch branch and a pull request will do since the workflow already triggers on `pull_request`; a job that has never failed has not been shown to gate anything.
The run's `head_sha` and conclusion for both the green and the red are recorded in `docs/MANUAL_TESTING.md`.
AGENTS.md's "nothing runs it for you (OW-49)" sentence says instead what now runs it and when a local run is still wanted: a push is a backstop after the fact, never a substitute for running the suite before committing, and the paths listed there stay the prompt for the local run.
`docs/DESIGN.md`, OW-24's last line, and OW-49's close note no longer call CI future or absent.

This card requires pushing to `origin`, which AGENTS.md forbids without being asked by name; the session that takes it needs that permission explicitly.
