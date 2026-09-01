/**
 * The compaction acknowledgment's place in the composer's action row
 * (OW-natiha), in a real browser.
 *
 * What the acknowledgment *says* and what it blocks stay in `App.test.ts`;
 * this spec is the two claims jsdom cannot settle. The status has to remain
 * visible after the Tools popover -- which jsdom does not implement -- closes
 * over it, and joining the action row must not overflow it horizontally,
 * which is a claim about real layout.
 */
import { expect, test } from "@playwright/test";

test("the compaction acknowledgment sits in the action row without overflowing it", async ({ page }) => {
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();

	const row = page.locator(".prompt-actions");
	const tools = row.getByText("Tools", { exact: true });
	await tools.click();
	const compact = page.getByRole("menuitem", { name: "Compact" });
	await compact.click();

	// The popover has closed over the click, and the acknowledgment stands
	// without it. The harness answers the request with a "running" status, so
	// the settled text is the running phase's.
	await expect(compact).toBeHidden();
	const status = row.locator("[role='status']");
	await expect(status).toBeVisible();
	await expect(status).toHaveText("Compacting context…");

	// Beside Tools, the control the operation came from -- not pushed to the
	// row's far end, and not over the button.
	const toolsBox = (await tools.boundingBox())!;
	const statusBox = (await status.boundingBox())!;
	const sendBox = (await page.getByRole("button", { name: "Send" }).boundingBox())!;
	expect(statusBox.x, "the status does not sit to the right of Tools").toBeGreaterThan(toolsBox.x + toolsBox.width);
	expect(statusBox.x + statusBox.width, "the status crowds the Send end of the row").toBeLessThan(sendBox.x);

	// Joining the row overflowed nothing: neither the row nor the page scrolls
	// horizontally.
	expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
	).toBe(0);
});
