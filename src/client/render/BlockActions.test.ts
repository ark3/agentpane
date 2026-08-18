/**
 * Per-block copy and expand (OW-63).
 *
 * The point of the buttons is completeness and precision over drag-selection,
 * so every assertion here is about *which string* reaches the clipboard: the
 * source the component already holds, never the rendered DOM, and never
 * limited to what the card chose to display. The overlay's contract is the
 * other half: real content in the body, explicit closes only.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Block from "./Block.svelte";
import Markdown from "./Markdown.svelte";
import Thinking from "./Thinking.svelte";
import type { ContentBlock } from "./types.ts";

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

let writeText: ReturnType<typeof vi.fn>;

function setClipboard(value: unknown): void {
	Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
	writeText = vi.fn(() => Promise.resolve());
	setClipboard({ writeText });
});

afterEach(() => {
	// jsdom has no clipboard of its own; leave the global as we found it.
	Reflect.deleteProperty(navigator, "clipboard");
});

/**
 * The controls for one block. `which` matters on a bash card, which is two
 * copyable blocks -- the command it ran, then the output it produced -- and
 * each one gets its own chrome rather than the card sharing a single button.
 */
function actions(scope: ParentNode, label: string, which = 0): HTMLElement {
	const all = [...scope.querySelectorAll(`[data-block-actions="${label}"]`)];
	const el = all.at(which);
	if (!el) throw new Error(`no ${label} controls at ${which} (found ${all.length})`);
	return el as HTMLElement;
}

function copyButton(scope: ParentNode, label: string, which = 0): HTMLButtonElement {
	return actions(scope, label, which).querySelector("button[data-copy]") as HTMLButtonElement;
}

function expandButton(scope: ParentNode, label: string, which = 0): HTMLButtonElement {
	return actions(scope, label, which).querySelector("button[data-expand]") as HTMLButtonElement;
}

function dialog(scope: ParentNode): HTMLElement | null {
	return scope.querySelector("[role='dialog']");
}

/** A tool result whose text is longer than `Output`'s 250000-character display limit. */
const longOutput = "a line of command output\n".repeat(10001);

function toolCallWithResult(text: string): { block: ContentBlock; results: Map<string, never> } {
	return {
		block: { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
		results: new Map([
			[
				"c1",
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text }],
					isError: false,
					timestamp: 1,
				},
			],
		]) as unknown as Map<string, never>,
	};
}

describe("copy", () => {
	it("copies a text block's markdown source, not its rendered prose", async () => {
		const text = "# Title\n\nsome **bold** prose";
		const { container } = render(Block, { props: { block: { type: "text", text } } });

		await fireEvent.click(copyButton(container, "text"));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
	});

	it("copies a fence's raw code, without the highlighting or the language tag", async () => {
		const code = "const x: number = 1;";
		const { container } = render(Block, {
			props: { block: { type: "text", text: `prose\n\n\`\`\`ts\n${code}\n\`\`\`` } },
		});

		// The control belongs to the fence: it is moved out of its dock to sit
		// with the <pre> the code renderer indexed.
		const pre = container.querySelector("pre.ap-code[data-fence='0']");
		const control = container.querySelector("[data-block-actions='code block']");
		expect(pre?.nextElementSibling?.contains(control)).toBe(true);

		await fireEvent.click(copyButton(container, "code block"));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
		expect(writeText.mock.calls[0]?.[0]).not.toContain("hljs");
	});

	it("copies a thinking block's own text", async () => {
		const text = "first I check the tests\nthen I read the row";
		const { container } = render(Thinking, { props: { text, streaming: false } });

		await fireEvent.click(copyButton(container, "thinking"));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
	});

	it("copies the whole of a tool result, not the truncated preview", async () => {
		const { block, results } = toolCallWithResult(longOutput);
		const { container } = render(Block, { props: { block, results } });

		// The card really is showing less than it copies.
		expect(container.querySelector(".clipped")).not.toBeNull();

		await fireEvent.click(copyButton(container, "output", -1));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(longOutput));
	});

	it("keeps a card's blocks apart: the command it ran is not the output it produced", async () => {
		const { block, results } = toolCallWithResult(longOutput);
		const { container } = render(Block, { props: { block, results } });

		await fireEvent.click(copyButton(container, "output", 0));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith("ls"));
	});

	it("shows a failure on the button when the write is rejected", async () => {
		writeText.mockRejectedValue(new Error("permission denied"));
		const { container } = render(Block, { props: { block: { type: "text", text: "hello" } } });
		const button = copyButton(container, "text");

		await fireEvent.click(button);

		await waitFor(() => expect(button.getAttribute("data-copy")).toBe("failed"));
	});

	it("shows a failure rather than throwing when there is no clipboard at all", async () => {
		// jsdom, and every non-secure origin, has no `navigator.clipboard`.
		setClipboard(undefined);
		const { container } = render(Block, { props: { block: { type: "text", text: "hello" } } });
		const button = copyButton(container, "text");

		await fireEvent.click(button);

		await waitFor(() => expect(button.getAttribute("data-copy")).toBe("failed"));
	});

	it("marks a successful copy and then clears the mark", async () => {
		vi.useFakeTimers();
		try {
			const { container } = render(Block, { props: { block: { type: "text", text: "hello" } } });
			const button = copyButton(container, "text");

			await fireEvent.click(button);
			await vi.waitFor(() => expect(button.getAttribute("data-copy")).toBe("copied"));

			await vi.advanceTimersByTimeAsync(2000);
			await tick();
			expect(button.getAttribute("data-copy")).toBe("idle");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("expand", () => {
	const text = "# Title\n\nsome **bold** prose\n\n```ts\nconst x = 1;\n```";

	it("opens a panel carrying the block's content, and puts focus in it", async () => {
		const { container } = render(Block, { props: { block: { type: "text", text } } });
		const opener = expandButton(container, "text");

		await fireEvent.click(opener);

		const panel = dialog(container);
		expect(panel).not.toBeNull();
		const body = panel?.querySelector("[data-expanded-body]");
		expect(body?.querySelector("h1")?.textContent).toBe("Title");
		expect(body?.querySelector("pre.ap-code")).not.toBeNull();
		expect(document.activeElement).toBe(panel);
	});

	it("keeps its own chrome out of the selectable body", async () => {
		// Copy-all and close live in the header; the body is content only, so a
		// drag-selection or the browser's own copy cannot pick up button text.
		const { container } = render(Block, { props: { block: { type: "text", text } } });
		await fireEvent.click(expandButton(container, "text"));

		const body = dialog(container)?.querySelector("[data-expanded-body]");
		expect(body?.querySelector("button")).toBeNull();
		expect(body?.querySelector("[data-block-actions]")).toBeNull();
	});

	it("does not close on a backdrop click", async () => {
		// A selection that ends on the backdrop must not be read as a dismiss.
		const { container } = render(Block, { props: { block: { type: "text", text } } });
		await fireEvent.click(expandButton(container, "text"));
		const backdrop = dialog(container)?.parentElement as HTMLElement;

		await fireEvent.click(backdrop);
		await tick();

		expect(dialog(container)).not.toBeNull();
	});

	it("closes on Esc and gives focus back", async () => {
		const { container } = render(Block, { props: { block: { type: "text", text } } });
		const opener = expandButton(container, "text");
		// jsdom's synthetic click does not focus, so put focus where a real
		// pointer or keyboard would have left it before opening.
		opener.focus();
		await fireEvent.click(opener);

		await fireEvent.keyDown(window, { key: "Escape" });
		await tick();

		expect(dialog(container)).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("closes on the X", async () => {
		const { container } = render(Block, { props: { block: { type: "text", text } } });
		await fireEvent.click(expandButton(container, "text"));

		await fireEvent.click(dialog(container)?.querySelector("[data-close]") as HTMLElement);
		await tick();

		expect(dialog(container)).toBeNull();
	});

	it("copies the whole source from the panel, past what the card would show", async () => {
		const { block, results } = toolCallWithResult(longOutput);
		const { container } = render(Block, { props: { block, results } });
		await fireEvent.click(expandButton(container, "output", -1));

		const copyAll = dialog(container)?.querySelector("button[data-copy]") as HTMLButtonElement;
		await fireEvent.click(copyAll);

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(longOutput));
	});
});

describe("fences while the message is still streaming", () => {
	/**
	 * A fence's control is not rendered where it lands: it is moved next to the
	 * `<pre>` the code renderer indexed. A streaming frame re-parses and so
	 * replaces every `<pre>`, and the fence *count* grows as the model writes --
	 * so the pairing has to be redone, not done once. (A one-shot attach passes
	 * the single-fence case above and fails this one, which is why it is here.)
	 */
	it("gives a fence that first appears mid-stream its own control", async () => {
		const control = (container: HTMLElement, index: number) =>
			container
				.querySelector(`pre.ap-code[data-fence='${index}']`)
				?.nextElementSibling?.querySelector("[data-block-actions]") ?? null;

		const { container, rerender } = render(Markdown, {
			props: { text: "```ts\nconst x = 1;\n```", streaming: true },
		});
		await nextFrame();
		await tick();
		expect(control(container, 0)).not.toBeNull();

		await rerender({ text: "```ts\nconst x = 1;\n```\n\nprose\n\n```sh\nls -l\n```", streaming: true });
		await nextFrame();
		await tick();

		expect(control(container, 0)).not.toBeNull();
		expect(control(container, 1)).not.toBeNull();
	});
});

describe("blocks with nothing to act on", () => {
	it("gives a signature-only thinking block no controls", () => {
		const { container } = render(Thinking, { props: { text: "", streaming: false } });
		expect(container.querySelector("[data-block-actions]")).toBeNull();
	});

	it("gives a redacted thinking block no controls", () => {
		const { container } = render(Thinking, { props: { text: "", redacted: true, streaming: false } });
		expect(container.querySelector("details")).not.toBeNull();
		expect(container.querySelector("[data-block-actions]")).toBeNull();
	});

	it("gives an empty text block no controls", () => {
		const { container } = render(Block, { props: { block: { type: "text", text: "" } } });
		expect(container.querySelector("[data-block-actions]")).toBeNull();
	});

	it("gives an image block no controls -- text actions act on text", () => {
		const { container } = render(Block, {
			props: { block: { type: "image", mimeType: "image/png", data: "AAAA" } },
		});
		expect(container.querySelector("img")).not.toBeNull();
		expect(container.querySelector("[data-block-actions]")).toBeNull();
	});
});
