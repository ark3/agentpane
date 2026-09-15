/**
 * What a *collapsed* tool card costs (OW-lisaye).
 *
 * A native `<details>` only hides a body it has already built, so before this
 * card's fix every collapsed tool card ran `renderCode` -- highlight.js plus a
 * DOMPurify pass, over a body allowed to reach 250000 characters (OW-64) --
 * for an output nobody had asked to see. D5 makes that the common case, not
 * the rare one: the collapsed line is the primary presentation.
 *
 * Counted, not timed, for the reason `App.streaming-cost.test.ts`'s docblock
 * gives. That file is also why this went unseen: its spy wraps
 * `renderMarkdownWithFences` only, so every `renderCode` call inside a tool
 * card was invisible to the one test guarding this area.
 */
import { render } from "@testing-library/svelte";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { highlights } = vi.hoisted(() => ({ highlights: vi.fn() }));

// `importOriginal`, so the renderer under test is the real one and the only
// change is that every call is counted.
vi.mock("../markdown.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../markdown.ts")>();
	return {
		...actual,
		renderCode(...args: Parameters<typeof actual.renderCode>) {
			highlights(...args);
			return actual.renderCode(...args);
		},
	};
});

import BashTool from "./BashTool.svelte";

/** Big enough that paying for it unasked is the whole complaint. */
const longOutput = "const x: number = 1;\n".repeat(8000);

const call: ToolCall = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
const result: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "c1",
	toolName: "bash",
	content: [{ type: "text", text: longOutput }],
	isError: false,
	timestamp: 1,
};

function card(container: HTMLElement): HTMLDetailsElement {
	const el = container.querySelector("details.tool");
	if (!el) throw new Error("no tool card rendered");
	return el as HTMLDetailsElement;
}

/** Open or close the card the way a reader does: through the disclosure itself. */
async function toggle(el: HTMLDetailsElement, open: boolean): Promise<void> {
	el.open = open;
	el.dispatchEvent(new Event("toggle"));
	await Promise.resolve();
}

beforeEach(() => highlights.mockClear());

describe("a collapsed tool card", () => {
	it("does not highlight a body nobody has opened", () => {
		const { container } = render(BashTool, { props: { call, result } });

		expect(card(container).open).toBe(false);
		expect(highlights).not.toHaveBeenCalled();
		expect(container.querySelector("pre.output")).toBeNull();
	});

	it("highlights the body once the reader opens it", async () => {
		const { container } = render(BashTool, { props: { call, result } });

		await toggle(card(container), true);

		expect(highlights).toHaveBeenCalled();
		expect(highlights.mock.calls.some(([code]) => (code as string).includes("const x: number = 1;"))).toBe(true);
	});

	it("does not buy the same highlight twice when the reader closes and reopens it", async () => {
		const { container } = render(BashTool, { props: { call, result } });
		const el = card(container);
		await toggle(el, true);
		const first = highlights.mock.calls.length;

		await toggle(el, false);
		await toggle(el, true);

		expect(highlights.mock.calls.length).toBe(first);
	});
});
