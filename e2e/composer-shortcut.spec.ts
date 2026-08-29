/**
 * The composer's shortcut to the last message, in a real browser (OW-relehi).
 *
 * The claim is about the action row, which now carries four controls at its
 * busiest -- Tools, "Stop and edit", the primary button and Stop -- and one of
 * them is a three-word label. Whether they still sit on one line is a statement
 * about boxes, and jsdom has none; `.prompt-actions` does not wrap, so the
 * failure mode is buttons squeezed or pushed past the row's right edge rather
 * than a second line appearing.
 *
 * `tools-menu.spec.ts` measures the same row but cannot cover this: it never
 * seeds a transcript, so with no user message to go back to the shortcut is not
 * rendered there at all.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

test("the last-message shortcut shares the action row rather than crowding it off", async ({ page }) => {
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seed(2));

	const row = page.locator(".prompt-actions");
	const tools = row.getByText("Tools", { exact: true });
	const shortcut = page.getByRole("button", { name: "Edit last message" });
	const send = page.getByRole("button", { name: "Send" });

	/**
	 * The row's controls all sit on its one line, and the row does not push the
	 * page into horizontal overflow. The overflow half is the assertion that
	 * bites: `.prompt-actions` never wraps, and its grid column is content-sized,
	 * so a row that outgrows the composer widens the whole page rather than
	 * spilling out of a fixed box -- checked by giving the shortcut a 40rem
	 * min-width, which left every control still inside a row that had itself
	 * grown 210px past the viewport.
	 */
	async function expectOnOneRow(...controls: ReturnType<typeof page.getByRole>[]) {
		const rowBox = (await row.boundingBox())!;
		for (const control of controls) {
			const box = (await control.boundingBox())!;
			const name = await control.innerText();
			expect(box.y, `${name} is not on the row's line`).toBeCloseTo(rowBox.y, 0);
			expect(box.height, `${name} is not the row's height`).toBeCloseTo(rowBox.height, 0);
		}
		const page_ = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
		}));
		expect(page_.scrollWidth, "the action row pushed the page into horizontal overflow")
			.toBeLessThanOrEqual(page_.clientWidth);
		expect(rowBox.x + rowBox.width, "the action row runs off the right of the viewport")
			.toBeLessThanOrEqual(page_.clientWidth);
	}

	// Idle: Tools still at the left, the shortcut between it and the primary button.
	await expectOnOneRow(tools, shortcut, send);
	const shortcutBox = (await shortcut.boundingBox())!;
	expect(shortcutBox.x, "the shortcut is not to the right of Tools")
		.toBeGreaterThan((await tools.boundingBox())!.x);
	expect((await send.boundingBox())!.x, "the primary button is not to the right of the shortcut")
		.toBeGreaterThan(shortcutBox.x);

	// Streaming is the busiest the row ever gets: the shortcut takes its longer
	// label and Stop appears beside it, which is where a fifth box would show.
	await page.getByLabel("Prompt").fill("another prompt");
	await send.click();
	const stop = page.getByRole("button", { name: "Stop", exact: true });
	await expect(stop).toBeVisible();
	await expectOnOneRow(tools, page.getByRole("button", { name: "Stop and edit" }), stop);
});
