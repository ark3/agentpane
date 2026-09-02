/**
 * The browser-owned controls follow the same system palette as the app
 * (OW-pofeto).
 *
 * The app resolves `prefers-color-scheme` to its document attribute, and that
 * attribute selects both its own tokens and native control chrome. This belongs
 * in Playwright because jsdom computes neither CSS custom properties nor chrome.
 */
import { expect, test } from "@playwright/test";

for (const palette of ["light", "dark"] as const) {
	test(`the document advertises the ${palette} system palette`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: palette });
		await page.goto("/e2e/harness.html");

		const scheme = await page.evaluate(
			() => getComputedStyle(document.documentElement).colorScheme,
		);
		expect(scheme).toBe(palette);
	});
}

test("an explicit dark theme selects the dark native palette and rendered tokens", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/e2e/harness.html");
	await page.getByLabel("Theme").selectOption("dark");

	expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
	expect(await page.getByRole("heading", { name: "agentpane" }).evaluate((el) => getComputedStyle(el).color))
		.toBe("rgb(228, 232, 238)");
});
