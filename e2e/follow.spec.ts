/**
 * Follow mode, and the transcript nav rail, in a real browser (OW-47, OW-60).
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

	await page.getByRole("button", { name: "Attach", exact: true }).click();
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

/**
 * The nav rail (OW-60). Two of the three claims here are unavailable to jsdom:
 * that the control does not move when the transcript scrolls under it -- the
 * whole defect it replaces -- and that its jumps land a user turn flush on the
 * pane's top edge, which is real layout arithmetic. The third, that a submit
 * still arms follow after the rail has been used, guards the shell's one hard
 * rule: only a submit arms follow, and the rail must not have disturbed that.
 */
test("the nav rail stays put while the transcript scrolls under it, and steps between user turns", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	// `seed(n)` writes user/assistant pairs, so user turns are the even indices.
	await page.evaluate(() => window.harness.seed(20));

	const rail = page.getByRole("navigation", { name: "Transcript navigation" });
	await expect(rail).toBeVisible();
	// Seeding only emits the snapshot; the transcript renders after it, and its
	// markdown height settles a frame later again (D5). `end` going live is the
	// pane reporting that it actually overflows -- scrolling before that lands
	// on a scroller with nothing to scroll.
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeEnabled();

	// A sibling of the scroller, never a child of it. Inside, it would scroll
	// away with the content it navigates, would sit over the transcript, and
	// would count toward the `scrollHeight` follow mode measures.
	const nested = await page.evaluate(() =>
		document.querySelector(".conversation")!.contains(document.querySelector("nav[aria-label='Transcript navigation']")),
	);
	expect(nested, "the rail is inside the scrolled conversation").toBe(false);

	const before = await rail.boundingBox();
	expect(before).not.toBeNull();

	// Scroll the transcript a long way. This is the case the old in-scroller
	// button failed: it rode the content out of view.
	await page.evaluate(() => {
		const el = document.querySelector<HTMLElement>(".conversation")!;
		el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
	});
	await expect
		.poll(async () => (await page.evaluate(() => window.harness.metrics(0))).scrollTop)
		.toBeGreaterThan(0);
	const after = await rail.boundingBox();
	expect(after!.y, "the rail moved when the transcript scrolled").toBeCloseTo(before!.y, 0);
	expect(after!.x).toBeCloseTo(before!.x, 0);
	await expect(rail).toBeInViewport();

	await page.getByRole("button", { name: "Jump to start" }).click();
	await expect(page.getByRole("button", { name: "Jump to start" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Previous user message" })).toBeDisabled();
	expect((await page.evaluate(() => window.harness.metrics(0))).scrollTop).toBe(0);

	// Forwards, then back the same way, each step landing the intended user turn
	// flush on the pane's top edge.
	for (const index of [2, 4, 6]) {
		await page.getByRole("button", { name: "Next user message" }).click();
		const { anchorOffset } = await page.evaluate((i) => window.harness.metrics(i), index);
		expect(Math.abs(anchorOffset!), `next did not land on user turn ${index}`).toBeLessThanOrEqual(LOCKED_PX);
	}
	for (const index of [4, 2]) {
		await page.getByRole("button", { name: "Previous user message" }).click();
		const { anchorOffset } = await page.evaluate((i) => window.harness.metrics(i), index);
		expect(Math.abs(anchorOffset!), `prev did not land on user turn ${index}`).toBeLessThanOrEqual(LOCKED_PX);
	}

	// `end` is the scroller's true bottom, not the last user turn.
	await page.getByRole("button", { name: "Jump to end" }).click();
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Next user message" })).toBeDisabled();
	const bottom = await page.evaluate(() => window.harness.metrics(0));
	expect(bottom.scrollHeight - bottom.scrollTop - bottom.clientHeight).toBeLessThanOrEqual(LOCKED_PX);

	// The rail cleared follow above and never re-armed it; a submit still does.
	await page.getByRole("button", { name: "Jump to start" }).click();
	await page.getByLabel("Prompt").fill("after using the rail: answer at length");
	await page.getByRole("button", { name: "Send" }).click();
	await page.evaluate(() => window.harness.settled());
	const { anchorOffset } = await page.evaluate(() => window.harness.metrics(window.harness.lastUserIndex()));
	expect(anchorOffset, "the submitted prompt is not anchored").not.toBeNull();
	expect(Math.abs(anchorOffset!), "a submit after using the rail did not arm follow")
		.toBeLessThanOrEqual(LOCKED_PX);
});
