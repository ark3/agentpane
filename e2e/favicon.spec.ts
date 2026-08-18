/**
 * The favicon, served and resolvable (OW-ropuwo).
 *
 * Here rather than in vitest because the two things that can break are both
 * outside the module graph: whether the static layer hands `/favicon.svg` back
 * at all, and whether a browser can follow the `<link rel="icon">` in the real
 * `index.html`. Nothing imports the file, so no unit test can notice it going
 * missing.
 *
 * The 200/`image/svg+xml` assertion is worth its line: the first cut of this
 * icon carried an em dash inside an XML comment, which is a parse error, and
 * the browser rendered exactly nothing with no console message. A served
 * favicon is not a valid one, so the image is decoded here too.
 */
import { expect, test } from "@playwright/test";

test("the served page links a favicon that resolves and decodes", async ({ page }) => {
	const direct = await page.request.get("/favicon.svg");
	expect(direct.status()).toBe(200);
	expect(direct.headers()["content-type"]).toContain("image/svg+xml");

	// `index.html` mounts the real app, whose first act is to call the backend.
	// No backend is running here and the icon does not need one; blocking the
	// calls keeps the proxy failures out of every run's log.
	await page.route("**/api/**", (route) => route.abort());
	await page.goto("/");
	const link = page.locator('link[rel="icon"]');
	expect(await link.count(), "index.html declares no favicon").toBe(1);
	const href = (await link.getAttribute("href"))!;

	const resolved = new URL(href, page.url()).toString();
	const linked = await page.request.get(resolved);
	expect(linked.status(), `the icon link ${href} does not resolve`).toBe(200);
	// Vite answers an unknown path with index.html, so a 200 alone proves
	// nothing about the href; the type is what separates a hit from the
	// SPA fallback.
	expect(linked.headers()["content-type"], `the icon link ${href} does not resolve`)
		.toContain("image/svg+xml");

	// A file that parses. A broken SVG still serves as 200 image/svg+xml.
	const size = await page.evaluate(
		(src) =>
			new Promise<number>((resolve) => {
				const img = new Image();
				img.onload = () => resolve(img.naturalWidth);
				img.onerror = () => resolve(0);
				img.src = src;
			}),
		resolved,
	);
	expect(size, "the icon served but did not decode as an image").toBeGreaterThan(0);
});
