/** The model label must fit the composer's busiest action row in a real browser. */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

test("the model selector stays on the action row without causing page overflow", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();

	const row = page.locator(".prompt-actions");
	const model = page.getByLabel("Conversation model");
	await expect(model).toBeEnabled();
	await model.selectOption("harness/model");
	await page.evaluate(() => window.harness.seed(2));

	await page.getByLabel("Prompt").fill("another prompt");
	await page.getByRole("button", { name: "Send" }).click();
	const controls = [
		model,
		page.getByRole("button", { name: "Tools" }),
		page.getByRole("button", { name: "External Editor" }),
		page.getByRole("button", { name: "Stop and edit" }),
		page.getByRole("button", { name: "Send" }),
		page.getByRole("button", { name: "Stop", exact: true }),
	];
	await expect(controls.at(-1)!).toBeVisible();

	const rowBox = (await row.boundingBox())!;
	for (const control of controls) {
		const box = (await control.boundingBox())!;
		expect(box.y).toBeCloseTo(rowBox.y, 0);
		expect(box.height).toBeCloseTo(rowBox.height, 0);
	}
	const widths = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(widths.scroll).toBeLessThanOrEqual(widths.client);
	expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(widths.client);
});
