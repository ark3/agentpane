/** The model picker must fit the composer's busiest empty-conversation action row. */
import { expect, test } from "@playwright/test";

test("the reported model selector stays on the action row without page overflow", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();

	const row = page.locator(".prompt-actions");
	const model = page.getByLabel("Conversation model");
	await expect(model).toHaveValue("harness/default");
	await model.selectOption("harness/model");
	await expect(model).toHaveValue("harness/model");

	const controls = [
		model,
		page.getByRole("button", { name: "Tools" }),
		page.getByRole("button", { name: "External Editor" }),
		page.getByRole("button", { name: "Send" }),
	];
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
