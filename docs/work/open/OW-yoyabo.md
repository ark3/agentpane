---
labels: [deferral]
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
