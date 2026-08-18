import { describe, expect, it } from "vitest";
import { nextPreviewDelay, PREVIEW_POLL_FAST_MS, PREVIEW_POLL_IDLE_MS } from "./preview-poll.ts";

describe("preview poll schedule", () => {
	it("starts idle and drops to the floor the moment a refresh finds a change", () => {
		expect(PREVIEW_POLL_IDLE_MS).toBe(16_000);
		expect(nextPreviewDelay(PREVIEW_POLL_IDLE_MS, true)).toBe(PREVIEW_POLL_FAST_MS);
		expect(PREVIEW_POLL_FAST_MS).toBe(1_000);
	});

	it("doubles a quiet delay up to the ceiling and then holds there", () => {
		const delays: number[] = [];
		let delay = nextPreviewDelay(PREVIEW_POLL_IDLE_MS, true);
		expect(delay).toBe(1_000);
		for (let tick = 0; tick < 5; tick += 1) {
			delay = nextPreviewDelay(delay, false);
			delays.push(delay);
		}

		// The last entry is the one that matters: the ceiling holds rather than
		// doubling past it.
		expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 16_000]);
	});

	it("snaps back to the floor from anywhere in the backoff", () => {
		expect(nextPreviewDelay(8_000, true)).toBe(PREVIEW_POLL_FAST_MS);
	});
});
