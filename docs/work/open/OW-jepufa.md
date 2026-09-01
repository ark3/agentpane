---
labels: [defect]
---

# Three descriptions still call the browser suite a follow-mode vehicle and one of them denies it is a suite at all.

`bunx playwright test --list` on 2026-09-01 reports 11 tests in 7 spec files: follow mode (5), plus the turn-done favicon badge, the composer shortcut, edit-and-fork chrome, the favicon wiring, the assistant footer row, and the tools menu's light dismiss.
The prose at the code describes something smaller and older.

- `playwright.config.ts`, opening docblock: "The browser test vehicle, for the claims jsdom cannot host -- follow mode (OW-47) and the tools menu's light dismiss (OW-80)." Two of the seven concerns.
- `e2e/harness.ts`, opening docblock: "Browser harness for follow-mode (OW-47)", and its closing "not a browser E2E suite". Its enumeration is longer but still trails the specs beside it, and the closing disclaimer now reads as the wrong claim: it is the browser UI suite, it simply has no server.
- `docs/MANUAL_TESTING.md`, "Still unverified": "the only browser vehicle is the synthetic `e2e/` follow-mode harness". This is the copy a reader looking for the testing story meets first.

What must stay true in every rewrite: the harness drives the real `App.svelte` and the real `controller.ts` against a synthetic `AgentpaneApi` port, with no backend, no subprocess, and no production server.
That boundary is not stale — it is exactly what OW-24 exists to cross, and a rewrite that blurs it trades one false description for another.
Do not write a test count into a docblock; name the concerns and name `bunx playwright test --list` as the way to get the current shape, because a number in a comment rots on the next spec.

## The gating to undo

`docs/work/open/OW-24.md`, under "## Done", currently requires whoever builds the production-server vertical slice to "retire the now-false descriptions in `playwright.config.ts` and `e2e/harness.ts`".
That puts a doc defect behind unrelated server work, against AGENTS.md's rule under "Landing work" that a doc defect is fixed in the same change that finds it.
Strike that clause from OW-24 and cite this card's id in its place; leave the rest of OW-24 alone.
OW-bafeja separately amends OW-24's last line about CI, so expect that file to be touched twice by two different cards.

## Done

The three descriptions name the suite for what it now covers and keep the no-server boundary explicit, and no claim in them exceeds what `--list` reports.
The OW-24 clause is struck and replaced by a pointer to this card.
`bun run check` passes, since comment-only edits to `playwright.config.ts` and `e2e/harness.ts` are still inside the typecheck's reach; `bun run test:browser` is not implicated, because no test or fixture changes.
