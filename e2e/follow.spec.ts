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
const PRESERVED_PX = 4;

async function afterLayout(page: import("@playwright/test").Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("reading view preserves a disengaged reader's user-turn landmark in both directions", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seed(30, true, true));
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeEnabled();

	const landmark = await page.evaluate(() => {
		const pane = document.querySelector<HTMLElement>(".conversation")!;
		const users = pane.querySelectorAll<HTMLElement>('[data-role="user"]');
		const node = users[15]!;
		const contentTop = node.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
		pane.scrollTop = contentTop - 73;
		return Number(node.dataset.index);
	});
	await expect.poll(async () => (await page.evaluate((index) => window.harness.metrics(index), landmark)).anchorOffset)
		.toBeCloseTo(73, 0);

	const chromeSides = await page.evaluate(() => {
		const pane = document.querySelector<HTMLElement>(".conversation")!;
		const top = pane.getBoundingClientRect().top;
		const bottom = pane.getBoundingClientRect().bottom;
		const chrome = Array.from(pane.querySelectorAll<HTMLElement>('[data-block="thinking"], [data-tool]'));
		return {
			above: chrome.some((node) => node.getBoundingClientRect().bottom < top),
			below: chrome.some((node) => node.getBoundingClientRect().top > bottom),
		};
	});
	expect(chromeSides).toEqual({ above: true, below: true });

	const reading = page.getByRole("button", { name: "Reading view", exact: true });
	const before = (await page.evaluate((index) => window.harness.metrics(index), landmark)).anchorOffset!;
	await reading.click();
	await expect(reading).toHaveAttribute("aria-pressed", "true");
	await afterLayout(page);
	const condensed = (await page.evaluate((index) => window.harness.metrics(index), landmark)).anchorOffset!;
	expect(condensed).toBeCloseTo(before, 0);
	expect(Math.abs(condensed - before)).toBeLessThanOrEqual(PRESERVED_PX);

	await reading.click();
	await expect(reading).toHaveAttribute("aria-pressed", "false");
	await afterLayout(page);
	const expanded = (await page.evaluate((index) => window.harness.metrics(index), landmark)).anchorOffset!;
	expect(Math.abs(expanded - before)).toBeLessThanOrEqual(PRESERVED_PX);
});

test("reading view leaves a disengaged transcript at the absolute top", async ({ page }) => {
	await page.goto("/e2e/harness.html");
	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seed(12, true));
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeEnabled();
	const reading = page.getByRole("button", { name: "Reading view", exact: true });

	for (const pressed of ["true", "false"]) {
		await reading.click();
		await expect(reading).toHaveAttribute("aria-pressed", pressed);
		await afterLayout(page);
		expect((await page.evaluate(() => window.harness.metrics(0))).scrollTop).toBe(0);
	}
});

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

test("rapid app-driven scrolls do not masquerade as a reader scroll", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => window.harness.seed(40));
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeEnabled();
	await page.getByRole("button", { name: "Jump to end" }).click();
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeDisabled();
	await page.evaluate(() => window.harness.pace(100, 1));
	await page.getByLabel("Prompt").fill("overlapping scroll events keep following");

	// Reproduce two app-driven assignments before the first native event reaches
	// App's scroll handler. The capture listener runs at the start of the first
	// event's delivery: its end jump performs the second assignment, then the
	// submit arms follow, and only then does that first event reach App. A single
	// suppression boolean consumes it and leaves the second event looking manual.
	await page.evaluate(() => {
		const pane = document.querySelector<HTMLElement>(".conversation")!;
		pane.addEventListener(
			"scroll",
			() => {
				(document.querySelector('button[aria-label="Jump to end"]') as HTMLButtonElement).click();
				(document.querySelector('button[type="submit"]') as HTMLButtonElement).click();
			},
			{ capture: true, once: true },
		);
	});
	await page.getByRole("button", { name: "Jump to start" }).click();
	await expect(page.locator('[role="log"]')).toHaveAttribute("aria-busy", "true");
	await page.evaluate(() => window.harness.settled());
	const { anchorOffset } = await page.evaluate(() =>
		window.harness.metrics(window.harness.lastUserIndex()),
	);
	expect(anchorOffset).not.toBeNull();
	expect(Math.abs(anchorOffset!), "a delayed programmatic scroll event disengaged follow")
		.toBeLessThanOrEqual(LOCKED_PX);
});

/**
 * Reading view changes the mounted transcript while a follow-armed turn is
 * still streaming. Its elisions must not renumber the submitted prompt or let
 * the browser's resize/scroll sequence disarm the anchor (OW-56).
 */
test("reading view keeps a streaming turn's original follow anchor locked", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	// Enough completed turns that the submitted prompt has to be followed into
	// a genuinely scrollable transcript, with a deliberately slow body phase
	// that keeps the turn live through both reading-view toggles.
	await page.evaluate(() => {
		window.harness.seed(24, true);
		window.harness.pace(160, 12);
	});
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeEnabled();

	const lastSeededUser = await page.evaluate(() => window.harness.lastUserIndex());
	await page.getByLabel("Prompt").fill("a paced turn keeps its landmark through reading view");
	await page.getByRole("button", { name: "Send" }).click();
	await page.waitForFunction((index) => window.harness.lastUserIndex() > index, lastSeededUser);

	// `lastUserIndex` is the original message-array position, rather than a
	// rendered-entry ordinal. Reading view removes several surrounding entries,
	// so a rewritten index would select a different node (or none at all).
	const anchorIndex = await page.evaluate(() => window.harness.lastUserIndex());
	const anchor = page.locator(`[data-role="user"][data-index="${anchorIndex}"]`);
	const streamedTurn = page.locator(`[data-role="assistant"][data-index="${anchorIndex + 1}"]`);
	await expect(streamedTurn.locator('[data-block="thinking"]')).toBeVisible();
	await expect(streamedTurn.locator('[data-tool="bash"]')).toBeVisible();
	await expect(anchor).toBeVisible();
	await expect
		.poll(async () => (await page.evaluate((index) => window.harness.metrics(index), anchorIndex)).anchorOffset)
		.toBeCloseTo(0, 0);
	// Pause the synthetic stream between chunks so only the toggle can restore
	// the anchor in the assertions below. Otherwise a later SSE upsert can run
	// the ordinary follow reconciliation and make the toggle path pass without
	// doing anything of its own.
	await page.evaluate(() => window.harness.pace(160, 1_000));

	const reading = page.getByRole("button", { name: "Reading view", exact: true });
	const transcript = page.locator('[role="log"]');
	await expect(transcript).toHaveAttribute("aria-busy", "true");
	await reading.click();
	await expect(reading).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator('[data-block="thinking"]')).toHaveCount(0);
	await expect(page.locator('[data-tool="bash"]')).toHaveCount(0);
	await expect(anchor).toBeVisible();
	const afterCondense = await page.evaluate(async (index) => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return window.harness.metrics(index);
	}, anchorIndex);
	expect(afterCondense.anchorOffset).not.toBeNull();
	expect(Math.abs(afterCondense.anchorOffset!), "condensing did not immediately restore armed follow")
		.toBeLessThanOrEqual(LOCKED_PX);

	await expect(transcript).toHaveAttribute("aria-busy", "true");
	await reading.click();
	await expect(reading).toHaveAttribute("aria-pressed", "false");
	await expect(streamedTurn.locator('[data-block="thinking"]')).toBeVisible();
	await expect(streamedTurn.locator('[data-tool="bash"]')).toBeVisible();
	await expect(anchor).toBeVisible();
	const afterRestore = await page.evaluate(async (index) => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return window.harness.metrics(index);
	}, anchorIndex);
	expect(afterRestore.anchorOffset).not.toBeNull();
	expect(Math.abs(afterRestore.anchorOffset!), "expanding did not immediately restore armed follow")
		.toBeLessThanOrEqual(LOCKED_PX);

	await page.evaluate(() => window.harness.pace(160, 12));
	await page.evaluate(() => window.harness.settled());
	const { anchorOffset } = await page.evaluate((index) => window.harness.metrics(index), anchorIndex);
	expect(anchorOffset, "the submitted prompt disappeared after the reading-view toggles").not.toBeNull();
	expect(Math.abs(anchorOffset!), "reading-view height changes disengaged follow")
		.toBeLessThanOrEqual(LOCKED_PX);
});

test("reading view follows its compact live tail appearing and settling away", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => {
		window.harness.seed(24);
		window.harness.pace(80, 250);
	});
	await expect(page.getByRole("button", { name: "Jump to end" })).toBeEnabled();
	await page.getByRole("button", { name: "Reading view", exact: true }).click();

	const lastSeededUser = await page.evaluate(() => window.harness.lastUserIndex());
	await page.getByLabel("Prompt").fill("follow the compact reading-view tail");
	await page.getByRole("button", { name: "Send" }).click();
	await page.waitForFunction((index) => window.harness.lastUserIndex() > index, lastSeededUser);
	const anchorIndex = await page.evaluate(() => window.harness.lastUserIndex());
	const status = page.locator("[data-reading-tail]");

	await expect(status).toHaveAttribute("data-reading-tail", "tool");
	await expect(status).toContainText("bash");
	// Hold the next body chunk far enough away that the geometry immediately
	// after visible prose replaces this status cannot be repaired by a later
	// streaming upsert before it is measured.
	await page.evaluate(() => window.harness.pace(80, 1_000));
	const appeared = await page.evaluate((index) => window.harness.metrics(index), anchorIndex);
	expect(appeared.anchorOffset).not.toBeNull();
	const appearedBottom = appeared.scrollHeight - appeared.scrollTop - appeared.clientHeight;
	expect(
		Math.min(Math.abs(appeared.anchorOffset!), appearedBottom),
		"the status appearance lost both bottom-follow and the locked prompt",
	).toBeLessThanOrEqual(LOCKED_PX);

	await expect(status).toHaveCount(0, { timeout: 10_000 });
	const disappeared = await page.evaluate(async (index) => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return window.harness.metrics(index);
	}, anchorIndex);
	expect(disappeared.anchorOffset).not.toBeNull();
	const disappearedBottom = disappeared.scrollHeight - disappeared.scrollTop - disappeared.clientHeight;
	expect(
		Math.min(Math.abs(disappeared.anchorOffset!), disappearedBottom),
		"the status disappearance lost both bottom-follow and the locked prompt",
	).toBeLessThanOrEqual(LOCKED_PX);

	await page.evaluate(() => window.harness.pace(80, 12));
	await page.evaluate(() => window.harness.settled());
	await expect(page.locator('[role="log"]')).toHaveAttribute("aria-busy", "false");
	const settled = await page.evaluate((index) => window.harness.metrics(index), anchorIndex);
	expect(settled.anchorOffset).not.toBeNull();
	expect(Math.abs(settled.anchorOffset!), "settling the status away disengaged follow")
		.toBeLessThanOrEqual(LOCKED_PX);
});

/** A real, fine-grained reader scroll must still win over follow mode (OW-56). */
test("a one-pixel manual scroll near the bottom disengages follow", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/e2e/harness.html");

	await page.getByRole("button", { name: "Attach", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toBeVisible();
	await page.evaluate(() => {
		window.harness.seed(24);
		window.harness.pace(4, 1_000);
	});

	await page.getByLabel("Prompt").fill("a real reader scroll overrides follow");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.locator('[data-tool="bash"]')).toBeVisible({ timeout: 10_000 });
	await expect(page.locator('[role="log"]')).toHaveAttribute("aria-busy", "true");

	const before = await page.evaluate(() => window.harness.metrics(window.harness.lastUserIndex()));
	const manual = await page.evaluate(() => {
		const pane = document.querySelector<HTMLElement>(".conversation")!;
		pane.scrollTop -= 1;
		return window.harness.metrics(window.harness.lastUserIndex());
	});
	expect(before.scrollTop - manual.scrollTop).toBe(1);
	await page.evaluate(() => window.harness.settled());
	const after = await page.evaluate(() => window.harness.metrics(window.harness.lastUserIndex()));
	expect(after.scrollTop, "follow overrode the reader's small manual scroll").toBeCloseTo(manual.scrollTop, 0);
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
