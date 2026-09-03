/**
 * Running markers stay at the content edge when their optional summary is
 * absent (OW-titisi). This is geometry, not merely the presence of a CSS rule,
 * so it needs Chromium's layout engine rather than jsdom.
 */
import { expect, test, type Locator } from "@playwright/test";
import type { FollowHarness } from "./harness.ts";

declare global {
	interface Window {
		harness: FollowHarness;
	}
}

interface RightEdges {
	marker: number;
	content: number;
}

async function rightEdges(row: Locator, marker: Locator): Promise<RightEdges> {
	return row.evaluate((element, markerElement) => {
		const rowBox = element.getBoundingClientRect();
		const markerBox = markerElement.getBoundingClientRect();
		const style = getComputedStyle(element);
		return {
			marker: markerBox.right,
			content:
				rowBox.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
		};
	}, await marker.elementHandle());
}

function expectAtContentEdge(edges: RightEdges): void {
	expect(edges.marker, "the running marker is not at the row's right content edge")
		.toBeCloseTo(edges.content, 0);
}

test("running markers keep their right edge with and without a summary", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();

	await page.evaluate(() => window.harness.seedAlignmentTool(false));
	const toolRow = page.locator('[data-tool="inspect"] > summary');
	const toolMarker = toolRow.locator(".status");
	await expect(toolMarker).toHaveText("running");
	const emptyTool = await rightEdges(toolRow, toolMarker);
	expectAtContentEdge(emptyTool);

	const reading = page.getByRole("button", { name: "Reading view", exact: true });
	await reading.click();
	const tailRow = page.locator("[data-reading-tail='tool']");
	const tailMarker = tailRow.locator(".tail-state");
	await expect(tailMarker).toHaveText("running");
	const emptyTail = await rightEdges(tailRow, tailMarker);
	expectAtContentEdge(emptyTail);

	await page.evaluate(() => window.harness.seedAlignmentTool(true));
	await expect(tailRow.locator(".tail-summary")).toHaveText("workspace");
	const summarizedTail = await rightEdges(tailRow, tailMarker);
	expectAtContentEdge(summarizedTail);
	expect(summarizedTail.marker, "adding the reading-tail summary moved its marker")
		.toBeCloseTo(emptyTail.marker, 0);

	await reading.click();
	await expect(toolRow.locator(".summary")).toHaveText("workspace");
	const summarizedTool = await rightEdges(toolRow, toolMarker);
	expectAtContentEdge(summarizedTool);
	expect(summarizedTool.marker, "adding the tool summary moved its marker")
		.toBeCloseTo(emptyTool.marker, 0);
});
