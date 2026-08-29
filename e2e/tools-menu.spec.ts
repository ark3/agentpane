/**
 * The composer's tools menu, in a real browser (OW-80).
 *
 * Light dismiss -- outside-click and Escape -- is the whole point of the swap
 * from `<details>` to the Popover API, and jsdom implements neither: probed
 * against this repo's jsdom, `element.showPopover` is `undefined` and a
 * `popovertarget` click is a no-op, so `:popover-open` never matches. The
 * behaviour therefore has no jsdom vehicle at all; what the menu *does* once
 * open stays in `App.test.ts`.
 *
 * Placement is here for the same reason: a popover renders in the top layer,
 * which is not positioned by the composer, so "still at the left end of the
 * action row, opening upward, with Send still pushed right" is a claim about
 * real layout that only a browser can settle.
 */
import { expect, test } from "@playwright/test";

test("the composer's tools menu light-dismisses and sits at the left of the action row", async ({ page }) => {
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();

	const tools = page.locator(".prompt-actions").getByText("Tools", { exact: true });
	const entry = page.getByRole("menuitem", { name: "New conversation" });
	const send = page.getByRole("button", { name: "Send" });

	// Placement: the menu opens upward from the Tools button, flush with its
	// left edge, and Tools still pushes Send to the right end of the row.
	await tools.click();
	await expect(entry).toBeVisible();
	const toolsBox = (await tools.boundingBox())!;
	const menuBox = (await page.locator(".tools-menu-list").boundingBox())!;
	const sendBox = (await send.boundingBox())!;
	expect(menuBox.x, "the menu is not flush with the left edge of Tools").toBeCloseTo(toolsBox.x, 0);
	expect(menuBox.y + menuBox.height, "the menu does not open upward from Tools")
		.toBeLessThanOrEqual(toolsBox.y);
	expect(sendBox.x, "Send is not pushed to the right of Tools").toBeGreaterThan(toolsBox.x + toolsBox.width);

	// Outside click dismisses. The masthead heading is inert -- clicking it can
	// close the menu and do nothing else.
	await page.getByRole("heading", { name: "agentpane" }).click();
	await expect(entry, "clicking outside left the menu open").toBeHidden();

	// Escape dismisses.
	await tools.click();
	await expect(entry).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(entry, "Escape left the menu open").toBeHidden();

	// Picking an entry closes the menu too -- the one thing the <details> did by
	// hand, and the one thing light dismiss does not do for you.
	await tools.click();
	const compact = page.getByRole("menuitem", { name: "Compact" });
	await compact.click();
	await expect(compact, "picking an entry left the menu open").toBeHidden();
});
