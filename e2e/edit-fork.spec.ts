/**
 * The edit-and-fork chrome, in a real browser (OW-hezidi).
 *
 * Two claims here are about layout, which jsdom has none of. The edit control
 * is an `.ap-action` "like copy and expand" -- the whole reason the item gives
 * for reusing that class is that a glyph in the shared row is exactly the size
 * of the buttons beside it and needs no separate thought about its hit area,
 * and "same row, same size" is measurable only where boxes exist. And the mode
 * banner is specified as sitting *above* the composer with Cancel in it, which
 * is a statement about where two elements are relative to each other.
 *
 * The transcript has to be live rather than previewed: a preview has no
 * composer, so it offers no edit control at all.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

test("the edit control rides the block action row, and its banner sits above the composer", async ({ page }) => {
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach" }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seed(2));

	const firstUserTurn = page.locator("[data-role='user']").first();
	const edit = firstUserTurn.getByRole("button", { name: "Edit message" });
	const copy = firstUserTurn.getByRole("button", { name: "Copy text" });
	await expect(edit).toHaveCount(1);

	// One row, and the same button size as the controls it sits with: that is
	// the whole of what `.ap-action` was reused for.
	const editBox = (await edit.boundingBox())!;
	const copyBox = (await copy.boundingBox())!;
	expect(editBox.y + editBox.height / 2, "edit is not on the copy button's line")
		.toBeCloseTo(copyBox.y + copyBox.height / 2, 0);
	expect(editBox.height, "edit is a different height from copy").toBeCloseTo(copyBox.height, 0);
	expect(editBox.width, "edit is a different width from copy").toBeCloseTo(copyBox.width, 0);

	await edit.click();

	// The banner explains the mode, which is what lets the button stay short --
	// so it has to be above the composer, not somewhere the eye has to find.
	const banner = page.locator(".edit-banner");
	const cancel = banner.getByRole("button", { name: "Cancel" });
	await expect(banner).toBeVisible();
	await expect(cancel).toBeVisible();
	const bannerBox = (await banner.boundingBox())!;
	const promptBox = (await page.getByLabel("Prompt").boundingBox())!;
	expect(bannerBox.y + bannerBox.height, "the banner is not above the composer")
		.toBeLessThanOrEqual(promptBox.y);

	await expect(page.getByRole("button", { name: "Fork" })).toBeVisible();
	// The tail is dimmed rather than hidden: still laid out, still readable.
	const tail = page.locator(".msg.dimmed").first();
	await expect(tail).toBeVisible();
	expect(await tail.evaluate((el) => Number(getComputedStyle(el).opacity)), "the tail after the edit point is not dimmed")
		.toBeLessThan(1);

	// D14: reachable with a pointer, and it puts the transcript back.
	await cancel.click();
	await expect(banner).toHaveCount(0);
	await expect(page.locator(".msg.dimmed")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});
