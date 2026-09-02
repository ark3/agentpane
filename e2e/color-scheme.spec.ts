/**
 * The browser-owned controls follow the same system palette as the app
 * (OW-pofeto).
 *
 * The app's tokens switch under `prefers-color-scheme`, but that does not tell
 * the browser which palette to use for native control chrome. This belongs in
 * Playwright because jsdom neither applies the media query nor paints widgets.
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
