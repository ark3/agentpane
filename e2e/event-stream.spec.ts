/**
 * What an `EventSource` error says about itself, in a real browser (OW-dekuri).
 *
 * The client heals a dropped stream at the re-open D21 put in `onOpen`, which
 * covers exactly the drops the browser retries by itself. A source that
 * reaches `CLOSED` never fires `onopen` again, so that path has to be told
 * apart from the ordinary one and rebuilt -- and `readyState`, read inside
 * `onerror`, is what tells them apart. This pins that reading.
 *
 * jsdom implements no `EventSource` at all, so `api.test.ts` can only assert
 * that the flag is forwarded; whether `readyState` actually carries it is a
 * browser fact and belongs here.
 */
import { expect, test } from "@playwright/test";

/** The `EventSource` constants, by value: the page evaluates these, not this file. */
const CONNECTING = 0;
const CLOSED = 2;

/** The `readyState` the first `onerror` against `url` reports. */
function firstErrorReadyState(page: import("@playwright/test").Page, url: string): Promise<number> {
	return page.evaluate((target) =>
		new Promise<number>((resolve) => {
			const source = new EventSource(target);
			source.onerror = () => {
				const state = source.readyState;
				source.close();
				resolve(state);
			};
		}), url);
}

test("an EventSource error reports a fatal close apart from a retried drop", async ({ page }) => {
	await page.route("**/sse-missing", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "no" }));
	// A complete, well-formed response: the stream opens and then ends, which is
	// the server cutting a live connection as far as the browser is concerned.
	await page.route("**/sse-cut", (route) =>
		route.fulfill({ status: 200, contentType: "text/event-stream", body: "data: {}\n\n" }));
	await page.goto("/e2e/harness.html");

	expect(await firstErrorReadyState(page, "/sse-missing")).toBe(CLOSED);
	expect(await firstErrorReadyState(page, "/sse-cut")).toBe(CONNECTING);
});
