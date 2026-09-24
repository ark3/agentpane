---
labels: [deferral]
closed: done
---

# Test comments and names still say a virtual session materialises on its first prompt, which D9 retired in OW-bohodu

OW-bohodu corrected D9 in `docs/DESIGN.md` ("A `virtual` session's id and its store file arrive at different times") and every non-test copy of the old claim, and scoped test files out.
As of that change, these test comments and test names still assert the retired version -- that a new session's id changes, or its file appears, at the first prompt:

- `src/server/http/session-manager.test.ts`, the two comments reading "materialises on its first prompt".
- `src/server/http/app.test.ts`, two comments near the create-then-prompt rename test.
- `src/server/http/vertical-slice.test.ts`, one comment on the rename.
- `src/server/adapters/pi/process.test.ts`, "A virtual session has no file yet, so Pi reports none (D9)" and its neighbour.
- `src/client/App.test.ts`, "rename on its first submit (D9: every new session gets one)" and one other.

Find them with `rg -n 'materialis|first prompt|first submit' src -g '*.test.ts'`.
`src/client/controller.test.ts`'s virtual-exit tests are not this card's: OW-wedupe reworks them.

This is comment and test-name text only.
Where a test's fake models the first-prompt rename (`materialiseOnSubmit` in `src/server/http/testing/fakes.ts`), the test is still valid -- D9 keeps that path as the case `virtual` describes -- and only its wording should change to say it is that case, not the normal life of a Pi session.

Done when that `rg` read by hand leaves no test comment or name asserting the retired version, and `bun run check` is green.

## Close note

Test names and comments that presented the first-prompt rename as a new session's normal life now describe it as the case D9 keeps: a backend that has named nothing by the end of attach. Landed as "test: say a first-prompt rename is the case virtual describes, not a new session's norm (OW-yoyabo)", comment and test-name text only, in four files: session-manager.test.ts (the "renames itself" describe comment and one test name), app.test.ts (one name, one comment), pi/process.test.ts (one name, one comment, citing D9's `pi 0.84.1`), and App.test.ts (one comment, one name). No assertions, fakes, option names (`materialiseOnSubmit`/`materialiseOnStart`) or fixture ids changed.

Sites the card listed that turned out not to need a change: vertical-slice.test.ts has no comment on the rename, and its test name ("follows a materialised id…") says nothing about timing. session-manager.test.ts had only one "materialises on its first prompt", and it was a test name, not a comment. The "materialised into the parent" alias comment near the fork tests is accurate.

A gap noticed and not filed: vertical-slice.test.ts models the first-prompt rename on a Codex fake, although Codex names its thread at attach, so on Codex that is a synthetic case. The test is really about renamed-then-snapshot ordering and is valid as written. Also, no app-level or client-level test drives the normal attach-time rename end to end; the manager-level "adopts the id the adapter took during start()" covers it one layer down.

Verified: `rg -n 'materialis|first prompt|first submit' src -g '*.test.ts'` read by hand on main after landing; bun run check green (54 files, 1268 tests).
