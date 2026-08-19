/**
 * The turn-done favicon badge, end to end in a real browser (OW-diyuwu).
 *
 * What is here and not in jsdom: that a real submit through the real
 * controller, followed by the real SSE event ordering of a turn, reaches a
 * real `<link rel="icon">` -- one this page did not declare, so the module
 * had to create it -- and that the badged file the swap points at is actually
 * served and actually decodes. A favicon that fails to parse renders as
 * nothing at all, silently; OW-ropuwo's first cut did exactly that.
 *
 * What is *not* here: the focus decision. `document.hasFocus` is stubbed by
 * the harness, for the reason its docblock records, and the decision itself is
 * proven over the pure reducer in `src/client/favicon.test.ts`.
 */
import { expect, test } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

/**
 * Slow enough that the assertion right after Send lands inside the window
 * where the turn has been submitted but `status:true` has not arrived yet --
 * the beat where a badge keyed off the level rather than the transition fires.
 */
const SLOW_TURN = { chunks: 4, ms: 120 };

test("a turn finishing unfocused badges the icon, and focus clears it", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");
	await page.evaluate(({ chunks, ms }) => window.harness.pace(chunks, ms), SLOW_TURN);

	await page.getByRole("button", { name: "Attach" }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();

	// `harness.html` declares no icon at all, so this element exists only
	// because the module made it -- the same code path `index.html` swaps.
	const icon = page.locator('link[rel="icon"]');
	await expect(icon).toHaveCount(1);
	const plain = (await icon.getAttribute("href"))!;
	expect(plain).not.toBe("");

	// Focused: a turn that finishes while you are looking does nothing at all.
	await page.evaluate(() => window.harness.setFocused(true));
	await page.getByLabel("Prompt").fill("a turn run in the foreground");
	await page.getByRole("button", { name: "Send" }).click();
	await page.evaluate(() => window.harness.settled());
	await expect(icon).toHaveAttribute("href", plain);

	// Unfocused: the same turn badges, but only once it has ended.
	await page.evaluate(() => window.harness.setFocused(false));
	await page.getByLabel("Prompt").fill("a turn run in the background");
	await page.getByRole("button", { name: "Send" }).click();
	expect(await icon.getAttribute("href"), "the badge fired on the submit, not on the turn ending")
		.toBe(plain);
	await page.evaluate(() => window.harness.settled());
	await expect(icon).not.toHaveAttribute("href", plain);
	const badged = (await icon.getAttribute("href"))!;

	// The file the swap now points at is served, and parses as an image. A
	// 200 alone proves nothing: Vite answers an unknown path with index.html.
	const resolved = new URL(badged, page.url()).toString();
	const response = await page.request.get(resolved);
	expect(response.status(), `the badged icon ${badged} does not resolve`).toBe(200);
	expect(response.headers()["content-type"], `the badged icon ${badged} does not resolve`)
		.toContain("image/svg+xml");
	const width = await page.evaluate(
		(src) =>
			new Promise<number>((resolve) => {
				const img = new Image();
				img.onload = () => resolve(img.naturalWidth);
				img.onerror = () => resolve(0);
				img.src = src;
			}),
		resolved,
	);
	expect(width, "the badged icon served but did not decode as an image").toBeGreaterThan(0);

	// Coming back to the tab clears it, without waiting for anything else.
	await page.evaluate(() => window.harness.setFocused(true));
	await expect(icon).toHaveAttribute("href", plain);
	await expect(icon).toHaveCount(1);
});
