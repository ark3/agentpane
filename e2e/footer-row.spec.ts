/**
 * An assistant turn's footer, in a real browser (OW-75).
 *
 * The defect was two rows where a user turn spends one, and "two rows" is a
 * statement about layout: jsdom has none, so the jsdom tests in
 * `Transcript.svelte.test.ts` can only say the meta is *inside* the block
 * action row's element. Whether that puts it on the same line as the buttons,
 * at the opposite end, is what this settles.
 *
 * No click is needed -- `App.svelte` auto-previews the top session on load, and
 * `harness.ts`'s `preview()` serves a completed, stamped assistant turn.
 */
import { expect, test } from "@playwright/test";

test("an assistant turn's meta shares one row with its block buttons", async ({ page }) => {
	await page.goto("/e2e/harness.html");

	const row = page.locator("[data-role='assistant'] [data-block-actions='text']");
	await expect(row).toHaveCount(1);

	const meta = row.locator(".meta");
	const copy = row.getByRole("button", { name: "Copy text" });
	await expect(meta).toBeVisible();

	const metaBox = (await meta.boundingBox())!;
	const copyBox = (await copy.boundingBox())!;

	// One row, two ways: the y-ranges overlap, and the two boxes are centred on
	// the same line. Either alone would pass for a tall meta stacked above.
	expect(metaBox.y, "the meta starts below the buttons").toBeLessThan(copyBox.y + copyBox.height);
	expect(copyBox.y, "the buttons start below the meta").toBeLessThan(metaBox.y + metaBox.height);
	expect(metaBox.y + metaBox.height / 2, "the meta is not on the buttons' line")
		.toBeCloseTo(copyBox.y + copyBox.height / 2, 0);

	// Facts at the left end, buttons at the right -- the row a user turn has.
	expect(metaBox.x + metaBox.width, "the meta is not left of the buttons")
		.toBeLessThanOrEqual(copyBox.x);
});
