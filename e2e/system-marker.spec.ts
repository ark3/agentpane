/**
 * A system message's marker stays one line, however much it names (OW-junuva).
 *
 * `Message.svelte` draws each Pi system message as a `<summary
 * class="system-marker">` over a collapsed `<details>` (OW-wavini), and keeps it
 * to one line with `white-space: nowrap`, `overflow: hidden` and
 * `text-overflow: ellipsis`. A later message's marker names every section and
 * tool it changes, so it can outrun the pane; whether it then wraps is a
 * statement about layout, which jsdom has none of -- nor any of a `<summary>`'s
 * `display: list-item` and disclosure triangle.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

test("each system marker is one line, and opens its disclosure when clicked", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seedSystem());

	const markers = page.locator("[data-role='system'] summary.system-marker");
	await expect(markers).toHaveCount(2);

	for (const [i, name] of ["leading", "later"].entries()) {
		const box = await markers.nth(i).evaluate((el) => ({
			height: el.getBoundingClientRect().height,
			lineHeight: parseFloat(getComputedStyle(el).lineHeight),
			scrollWidth: el.scrollWidth,
			clientWidth: el.clientWidth,
		}));
		expect(Number.isFinite(box.lineHeight), `the ${name} marker's line-height is not a length`).toBe(true);
		expect(box.height, `the ${name} marker is not one line`).toBeLessThan(box.lineHeight * 1.5);
		// Without this the later fixture could pass by being short enough to fit.
		if (name === "later") {
			expect(box.scrollWidth, "the later marker fits the pane, so nothing needed the ellipsis")
				.toBeGreaterThan(box.clientWidth);
		}
	}

	const later = page.locator("[data-role='system']").nth(1);
	await expect(later.locator(".system-body")).toBeHidden();
	await markers.nth(1).click();
	await expect(later.locator("details")).toHaveAttribute("open", "");
	await expect(later.locator(".system-body")).toBeVisible();
});
