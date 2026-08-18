/**
 * `Output`'s display cap (OW-64): 250000 characters, raised from an earlier
 * 20000 that was tighter than the browser can comfortably render. The
 * truncation mechanism itself -- and the notice past the cap -- is untouched;
 * this only checks the new threshold sits where the prop default says it does.
 */
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Output from "./Output.svelte";

describe("Output", () => {
	it("renders a body under the 250000-character limit in full, with no truncation notice", () => {
		const text = "a".repeat(200_000);
		const { container } = render(Output, { props: { text } });

		expect(container.querySelector(".clipped")).toBeNull();
		expect(container.querySelector("pre.output")?.textContent?.length).toBe(text.length);
	});

	it("still truncates a body over the 250000-character limit, and names the full count", () => {
		const text = "a".repeat(260_000);
		const { container } = render(Output, { props: { text } });

		expect(container.querySelector(".clipped")?.textContent).toContain("260,000");
		const shown = container.querySelector("pre.output")?.textContent ?? "";
		expect(shown.length).toBeLessThan(text.length);
	});
});
