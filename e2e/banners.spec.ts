/**
 * The shell-level banners' place in the grid (OW-watajo), in a real browser.
 *
 * The turn error, the backend notices, the unrestored-model warning and the
 * blocked-request warning are read where the conversation is: above it, inside
 * its column, in both the wide and the single-column layout. With no banner
 * showing, the conversation must not pay for their row -- an empty grid track
 * still costs a `gap`. jsdom has no layout, so neither claim can be made there.
 */
import { expect, test, type Page } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };

async function box(page: Page, selector: string): Promise<Box> {
	const found = await page.locator(selector).boundingBox();
	if (!found) throw new Error(`no box for ${selector}`);
	return found;
}

async function attach(page: Page): Promise<void> {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seed(3));
}

const BANNERS = [
	["the error", ".shell [role='alert']"],
	["the backend notices", ".shell [aria-label='Backend notices']"],
	["the unrestored-model warning", ".shell [aria-label='Unrestored model']"],
	["the blocked-request warning", ".shell p.warning:has-text('blocked on a request')"],
] as const;

async function expectBannersWithConversation(page: Page): Promise<void> {
	await page.evaluate(() => window.harness.showBanners());
	for (const [, selector] of BANNERS) await expect(page.locator(selector)).toBeVisible();

	const conversation = await box(page, ".conversation");
	const prompt = await box(page, ".prompt");
	for (const [name, selector] of BANNERS) {
		const banner = await box(page, selector);
		expect(banner.y + banner.height, `${name} sits above the prompt`).toBeLessThanOrEqual(prompt.y);
		expect(banner.y + banner.height, `${name} sits above the conversation`).toBeLessThanOrEqual(conversation.y);
		expect(banner.x, `${name} starts inside the conversation column`).toBeGreaterThanOrEqual(conversation.x - 1);
		expect(banner.x + banner.width, `${name} ends inside the conversation column`).toBeLessThanOrEqual(conversation.x + conversation.width + 1);
	}
}

test("with no banner showing, the wide layout's conversation starts level with the session controls", async ({ page }) => {
	await attach(page);
	const conversation = await box(page, ".conversation");
	const controls = await box(page, ".session-controls");
	expect(conversation.y).toBeCloseTo(controls.y, 0);
});

test("the shell's banners sit above the conversation, in its column, in the wide layout", async ({ page }) => {
	await attach(page);
	await expectBannersWithConversation(page);
});

test.describe("single-column layout", () => {
	// 42rem is 672px at the default font size.
	test.use({ viewport: { width: 600, height: 900 } });

	test("with no banner showing, the conversation sits one gap below the session list", async ({ page }) => {
		await attach(page);
		const conversation = await box(page, ".conversation");
		const sessions = await box(page, ".sessions");
		const gap = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".shell")!).rowGap));
		expect(conversation.y - (sessions.y + sessions.height)).toBeCloseTo(gap, 0);
	});

	test("the shell's banners sit above the conversation, in its column", async ({ page }) => {
		await attach(page);
		await expectBannersWithConversation(page);
	});
});
