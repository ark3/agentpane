/**
 * D5: "keep thinking blocks visually recessive". Recessive here is behavioural
 * as much as visual -- open while the model is reasoning, closed once the turn
 * settles, and out of the reader's way once they have said what they want.
 */
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import Thinking from "./Thinking.svelte";

/** The `toggle` event is queued as a task, so let the queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function details(container: HTMLElement): HTMLDetailsElement {
	const el = container.querySelector("details");
	if (!el) throw new Error("no <details> rendered");
	return el as HTMLDetailsElement;
}

/**
 * What a click on the summary does at the DOM level: the browser's default
 * activation behaviour flips `open` and then queues a `toggle` event. jsdom
 * does not run activation behaviour for <summary>, so drive the same two steps
 * directly rather than asserting on a click that would do nothing.
 */
async function readerToggles(el: HTMLDetailsElement): Promise<void> {
	el.open = !el.open;
	await settle();
	await tick();
}

describe("Thinking", () => {
	it("is open while the block is streaming", async () => {
		const { container } = render(Thinking, { props: { text: "step one", streaming: true } });
		await settle();
		expect(details(container).open).toBe(true);
	});

	it("closes itself when the turn settles", async () => {
		// Regression: `toggle` fires for programmatic changes too, so the
		// auto-open echoed back as a reader decision and the block stayed open
		// for the rest of the session.
		const { container, rerender } = render(Thinking, {
			props: { text: "step one", streaming: true },
		});
		await settle();
		await rerender({ text: "step one", streaming: false });
		await tick();
		await settle();
		expect(details(container).open).toBe(false);
	});

	it("keeps the reader's decision when the turn settles", async () => {
		const { container, rerender } = render(Thinking, {
			props: { text: "step one", streaming: true },
		});
		await settle();
		const el = details(container);
		await readerToggles(el); // reader closes it mid-stream
		expect(el.open).toBe(false);

		await rerender({ text: "step one", streaming: false });
		await tick();
		await settle();
		expect(el.open).toBe(false);
	});

	it("keeps a block the reader opened open across a new turn", async () => {
		const { container, rerender } = render(Thinking, {
			props: { text: "step one", streaming: false },
		});
		await settle();
		const el = details(container);
		await readerToggles(el); // reader opens a settled block
		expect(el.open).toBe(true);

		await rerender({ text: "step one and two", streaming: true });
		await tick();
		await settle();
		await rerender({ text: "step one and two", streaming: false });
		await tick();
		await settle();
		expect(el.open).toBe(true);
	});

	it("shows a one-line preview in the summary", () => {
		const { container } = render(Thinking, {
			props: { text: "first line\nsecond line", streaming: false },
		});
		expect(container.querySelector(".preview")?.textContent).toBe("first line second line");
	});

	it("renders nothing for a signature-only block", () => {
		// Pi emits thinking blocks with no text at all, carrying only an opaque
		// signature (resources/fixtures/pi/tool-read.jsonl).
		const { container } = render(Thinking, { props: { text: "", streaming: false } });
		expect(container.querySelector("details")).toBeNull();
	});

	it("says so when the provider redacted the reasoning", () => {
		const { container } = render(Thinking, {
			props: { text: "", redacted: true, streaming: false },
		});
		expect(container.querySelector("details")).not.toBeNull();
		expect(container.textContent).toContain("redacted");
	});
});
