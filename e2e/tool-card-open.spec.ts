/**
 * A tool card builds its body on first open, never before (OW-lisaye).
 *
 * The jsdom test in `src/client/render/tools/ToolCard.test.ts` counts the
 * highlight calls, but it opens the card by setting `open` and dispatching
 * `toggle` by hand -- jsdom fires none of its own. What that cannot show is
 * the half the fix rests on: that a real disclosure, clicked by a reader,
 * fires the `toggle` the component listens to.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

test("a tool card's body arrives when the reader opens it, not before", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	// `withElidedChrome`, which is the seed that ends the transcript on a bash
	// call and its result.
	await page.evaluate(() => window.harness.seed(1, true));

	const card = page.locator("details.tool").first();
	await expect(card).toBeVisible();
	expect(await card.locator("pre.output").count(), "a collapsed card built its body anyway").toBe(0);

	await card.locator("summary").click();

	await expect(card.locator("pre.output").first()).toBeVisible();
});
