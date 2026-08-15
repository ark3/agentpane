/**
 * Follow mode in a real browser (OW-47).
 *
 * The spec (OW-27) is that a submit arms follow, the viewport tracks the
 * growing answer, and the submitted prompt rises until its own top edge sits
 * flush against the top of the pane -- where it locks. This asserts that the
 * *tenth* turn of a long conversation does that just as the first one does.
 *
 * jsdom cannot cover this. The cause of OW-47 was the browser moving the
 * scroll position itself as the transcript resized under it (CSS scroll
 * anchoring), which fires a `scroll` event no jsdom test can produce and no
 * jsdom layout can trigger.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

/** Flush-at-the-top, measured in real layout: the prompt's top edge on the pane's. */
const LOCKED_PX = 2;

test("a long conversation autoscrolls on every turn the way its first few do", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach" }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();

	// Long enough that every turn below starts far down a tall transcript.
	await page.evaluate(() => window.harness.seed(40));

	const offsets: number[] = [];
	for (let turn = 0; turn < 10; turn++) {
		await page.getByLabel("Prompt").fill(`turn ${turn}: answer at length`);
		await page.getByRole("button", { name: "Send" }).click();
		await page.evaluate(() => window.harness.settled());

		const { anchorOffset } = await page.evaluate(() =>
			window.harness.metrics(window.harness.lastUserIndex()),
		);
		expect(anchorOffset, `turn ${turn}: the submitted prompt is not anchored`).not.toBeNull();
		offsets.push(anchorOffset!);
	}

	// Every turn, not just the early ones: the prompt ends the turn locked
	// flush at the top of the pane. Before the fix the anchor was cleared
	// mid-turn by a scroll the app never performed, leaving the prompt
	// stranded tens of pixels down the pane.
	for (const [turn, offset] of offsets.entries()) {
		expect(Math.abs(offset), `turn ${turn} stopped ${offset.toFixed(1)}px from the top`)
			.toBeLessThanOrEqual(LOCKED_PX);
	}
});
