/**
 * Block dispatch -- the centre of D5. One component per block type, chosen by
 * `block.type`, so that a message's role never decides how its contents draw.
 */
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import Block from "./Block.svelte";
import type { ContentBlock } from "./types.ts";

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

function renderBlock(block: ContentBlock, extra: Record<string, unknown> = {}) {
	return render(Block, { props: { block, ...extra } });
}

describe("Block", () => {
	it("renders a text block as markdown", () => {
		const { container } = renderBlock({ type: "text", text: "# Title\n\nsome **bold** prose" });
		expect(container.querySelector(".markdown h1")?.textContent).toBe("Title");
		expect(container.querySelector(".markdown strong")?.textContent).toBe("bold");
	});

	it("renders a thinking block, recessive and closed once settled", () => {
		const { container } = renderBlock({ type: "thinking", thinking: "hmm" });
		const details = container.querySelector("details[data-block='thinking']");
		expect(details).not.toBeNull();
		expect((details as HTMLDetailsElement).open).toBe(false);
	});

	it("renders a toolCall block through the registry", () => {
		const { container } = renderBlock({
			type: "toolCall",
			id: "c1",
			name: "bash",
			arguments: { command: "ls" },
		});
		expect(container.querySelector("details.tool")?.getAttribute("data-tool")).toBe("bash");
	});

	it("hands a toolCall its matching result", () => {
		const results = new Map([
			[
				"c1",
				{
					role: "toolResult" as const,
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text" as const, text: "a-file.txt" }],
					isError: false,
					timestamp: 1,
				},
			],
		]);
		const { container } = renderBlock(
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
			{ results },
		);
		expect(container.textContent).toContain("a-file.txt");
	});

	it("renders an image block as a data url", () => {
		const { container } = renderBlock({ type: "image", mimeType: "image/png", data: "AAAA" });
		expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
	});

	it("refuses an image block whose mime type is not an image", () => {
		// A `data:` url with a document mime type is a script-execution vector;
		// an image block has no reason to carry one.
		for (const mimeType of ["text/html", "image/svg+xml", "application/javascript", ""]) {
			const { container } = renderBlock({ type: "image", mimeType, data: "PHN2Zz4=" });
			expect(container.querySelector("img")).toBeNull();
			expect(container.textContent).toContain("Unsupported image type");
		}
	});

	it("cannot be talked out of the data url by a hostile mime type", () => {
		const { container } = renderBlock({
			type: "image",
			mimeType: 'image/png" onerror="alert(1)',
			data: "AAAA",
		});
		expect(container.querySelector("img")).toBeNull();
	});

	it("renders nothing for a block type it does not know", () => {
		const { container } = renderBlock({ type: "somethingNew" } as unknown as ContentBlock);
		expect(container.textContent?.trim()).toBe("");
	});
});

describe("markdown blocks and hostile content", () => {
	/**
	 * The end-to-end version of markdown.test.ts: the same payloads, but
	 * through the component that actually calls `{@html}`. This is the test
	 * that would catch someone routing around `renderMarkdown`.
	 */
	it.each([
		"<script>alert(1)</script>",
		'<img src=x onerror="alert(1)">',
		"[click](javascript:alert(1))",
		'<iframe src="https://example.invalid"></iframe>',
		'<div style="position:fixed;inset:0">overlay</div>',
		"<style>body{display:none}</style>",
	])("builds nothing live from %s", (source) => {
		const { container } = renderBlock({ type: "text", text: source });
		expect(container.querySelector("script, iframe, style, form")).toBeNull();
		for (const el of container.querySelectorAll(".markdown *")) {
			for (const attr of el.attributes) {
				expect(attr.name).not.toMatch(/^on/i);
				expect(attr.name).not.toBe("style");
			}
		}
	});

	it("hardens outbound links but leaves in-document ones alone", () => {
		const { container } = renderBlock({
			type: "text",
			text: "[out](https://example.invalid/x) and [in](#here)",
		});
		const [out, inside] = [...container.querySelectorAll("a")];
		expect(out?.getAttribute("target")).toBe("_blank");
		expect(out?.getAttribute("rel")).toContain("noopener");
		expect(inside?.getAttribute("target")).toBeNull();
	});
});

describe("markdown streaming", () => {
	it("paints the first token synchronously", () => {
		// A settled transcript must never be a frame behind, so seeding is sync.
		const { container } = renderBlock({ type: "text", text: "hello" }, { streaming: true });
		expect(container.textContent).toContain("hello");
	});

	it("coalesces mid-turn updates into one frame", async () => {
		const { container, rerender } = renderBlock({ type: "text", text: "a" }, { streaming: true });
		await rerender({ block: { type: "text", text: "a b c" }, streaming: true });
		await tick();
		// Still the previous parse: the point of the throttle (D5's hot spot).
		expect(container.textContent).toContain("a");
		expect(container.textContent).not.toContain("a b c");

		await nextFrame();
		await tick();
		expect(container.textContent).toContain("a b c");
	});

	it("flushes synchronously when the turn settles", async () => {
		const { container, rerender } = renderBlock({ type: "text", text: "a" }, { streaming: true });
		await rerender({ block: { type: "text", text: "final text" }, streaming: false });
		await tick();
		expect(container.textContent).toContain("final text");
	});
});
