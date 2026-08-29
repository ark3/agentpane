---
labels: [defect, browser-testing]
---

# The attached-row accessible name makes six Playwright Attach locators ambiguous.

`e2e/badge.spec.ts`, `e2e/composer-shortcut.spec.ts`, `e2e/edit-fork.spec.ts`, both tests in `e2e/follow.spec.ts`, and `e2e/tools-menu.spec.ts` all call `getByRole("button", { name: "Attach" })` without an exact-name constraint.
Closed OW-lepoki changed attached session rows in `src/client/App.svelte` to announce `${label} (attached)`, so Playwright's substring name matching now resolves both the attached row and the preview's `Attach` button.
`bun run test:browser` on 2026-08-28 reproduced the same strict-mode violation in all six tests, while the favicon and footer-row tests passed.
A focused rerun with `bunx playwright test e2e/composer-shortcut.spec.ts` reproduced it again, and the failure itself identifies the exact `Attach` button as the intended second match.
Keep OW-lepoki's accessible status announcement and make the six preview-attach locators select the exact accessible name; this is test repair, not a product-label rollback.
Done when the existing red reproduction is preserved in the card history, all affected locators identify exactly the preview `Attach` button, and `bun run test:browser` passes before OW-56 begins.

Updated the six preview Attach-button locators across five Playwright specs to use exact accessible-name matching, preserving OW-lepoki's attached-session announcement while removing the strict-mode collision.
The focused composer-shortcut spec reproduced the two-match failure before the change and passed after it.
The full `bun run test:browser` suite passed 8/8 on the finished commit, and an adversarial reader found no spec or code-quality issues.
Landed on main as c414b92.
