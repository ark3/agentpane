/**
 * A collapsed thinking block's preview stays one clipped line (OW-55).
 *
 * `Thinking.svelte` draws the block as a `<details>` whose `<summary>` is a flex
 * row of the "Thinking" label and a `.preview` span carrying `oneLine(text, 80)`,
 * and keeps that span to one line with `min-width: 0`, `overflow: hidden`,
 * `text-overflow: ellipsis` and `white-space: nowrap`. Whether an 80-character
 * preview then wraps, or pushes the row past the pane, is a statement about
 * flex layout, which jsdom has none of.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

test("a collapsed thinking preview is one line, clipped with an ellipsis, and the block still opens", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seedThinking());

	const thinking = page.locator("details.thinking");
	await expect(thinking).toHaveCount(1);
	await expect(thinking).not.toHaveAttribute("open", "");

	const box = await thinking.evaluate((details) => {
		const summary = details.querySelector("summary")!;
		const preview = summary.querySelector<HTMLElement>(".preview")!;
		const pane = document.querySelector<HTMLElement>(".conversation")!;
		const s = summary.getBoundingClientRect();
		const p = preview.getBoundingClientRect();
		const c = pane.getBoundingClientRect();
		return {
			summaryHeight: s.height,
			lineHeight: parseFloat(getComputedStyle(preview).lineHeight),
			preview: { left: p.left, right: p.right, top: p.top, bottom: p.bottom },
			summary: { left: s.left, right: s.right, top: s.top, bottom: s.bottom },
			paneLeft: c.left,
			paneRight: c.left + pane.clientWidth,
			paneScrollWidth: pane.scrollWidth,
			paneClientWidth: pane.clientWidth,
			scrollWidth: preview.scrollWidth,
			clientWidth: preview.clientWidth,
			textOverflow: getComputedStyle(preview).textOverflow,
		};
	});
	expect(Number.isFinite(box.lineHeight), "the preview's line-height is not a length").toBe(true);
	expect(box.summaryHeight, "the collapsed summary is not one line").toBeLessThan(box.lineHeight * 1.5);

	// Without this the fixture could pass by being short enough to fit.
	expect(box.scrollWidth, "the preview fits its row, so nothing is cut off").toBeGreaterThan(box.clientWidth);
	expect(box.textOverflow, "the preview is cut off without an ellipsis").toBe("ellipsis");

	expect(box.preview.left, "the preview starts left of its summary").toBeGreaterThanOrEqual(box.summary.left);
	expect(box.preview.right, "the preview overruns its summary").toBeLessThanOrEqual(box.summary.right);
	expect(box.preview.top, "the preview rises above its summary").toBeGreaterThanOrEqual(box.summary.top);
	expect(box.preview.bottom, "the preview hangs below its summary").toBeLessThanOrEqual(box.summary.bottom);
	expect(box.preview.left, "the preview starts left of the pane").toBeGreaterThanOrEqual(box.paneLeft);
	expect(box.preview.right, "the preview overruns the pane").toBeLessThanOrEqual(box.paneRight);
	// The box alone is not enough: with `overflow: hidden` gone the span still fits
	// its row while its text spills past the pane and the transcript scrolls sideways.
	expect(box.paneScrollWidth, "the transcript scrolls sideways to reach the preview").toBeLessThanOrEqual(box.paneClientWidth);

	// The control: the collapsed row is a disclosure, and opening it shows the body.
	await expect(thinking.locator(".body")).toBeHidden();
	await thinking.locator("summary").click();
	await expect(thinking).toHaveAttribute("open", "");
	await expect(thinking.locator(".body")).toBeVisible();
});
