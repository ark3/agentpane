/**
 * The tool cards and the registry that picks them (D5).
 *
 * Everything here goes through `ToolCallBlock`, which is the only component
 * that knows tool names -- so these are also the tests of the registry's
 * default entry, the one thing `pi-web-ui` never had and Codex's arbitrary
 * `mcpToolCall` names make mandatory.
 */
import { render } from "@testing-library/svelte";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import ToolCallBlock from "../ToolCallBlock.svelte";
import { defaultToolRenderer, registeredToolNames, resolveToolRenderer } from "./registry.ts";
import DefaultTool from "./DefaultTool.svelte";
import BashTool from "./BashTool.svelte";

function call(name: string, args: Record<string, unknown> = {}, id = "call_1"): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function result(text: string, isError = false, toolName = "tool"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	};
}

function card(container: HTMLElement): HTMLDetailsElement {
	const el = container.querySelector("details.tool");
	if (!el) throw new Error("no tool card rendered");
	return el as HTMLDetailsElement;
}

const summaryLine = (container: HTMLElement) =>
	container.querySelector("details.tool > summary")?.textContent?.replace(/\s+/g, " ").trim();

describe("the registry", () => {
	it("resolves the tools it knows", () => {
		expect(registeredToolNames()).toEqual(expect.arrayContaining(["bash", "read", "write", "edit"]));
		expect(resolveToolRenderer("bash")).toBe(BashTool);
	});

	it("matches names case-insensitively", () => {
		expect(resolveToolRenderer("Bash")).toBe(resolveToolRenderer("bash"));
		expect(resolveToolRenderer("READ")).toBe(resolveToolRenderer("read"));
	});

	it("falls back to the default entry for a name nobody registered", () => {
		// Codex's mcpToolCall / dynamicToolCall carry names like this. There is
		// no list to add them to, which is why the default is not optional.
		expect(resolveToolRenderer("weather__forecast")).toBe(defaultToolRenderer);
		expect(resolveToolRenderer("")).toBe(defaultToolRenderer);
		expect(defaultToolRenderer).toBe(DefaultTool);
	});
});

describe("tool cards", () => {
	it("are collapsed behind a one-line summary (D5)", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("bash", { command: "bun run test" }) },
		});
		expect(card(container).open).toBe(false);
		expect(summaryLine(container)).toContain("bun run test");
	});

	it("collapse a multi-line summary onto one line", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("bash", { command: "one\ntwo\nthree" }) },
		});
		expect(summaryLine(container)).toContain("one two three");
	});

	it("mark a running call", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("bash", { command: "sleep 1" }), streaming: true },
		});
		expect(card(container).dataset.state).toBe("running");
	});

	it("mark a failed call", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("bash", { command: "false" }), result: result("boom", true) },
		});
		expect(card(container).dataset.state).toBe("error");
		expect(container.querySelector("pre.output.error")?.textContent).toContain("boom");
	});

	it("render an unknown tool through the default card, with its arguments", () => {
		const { container } = render(ToolCallBlock, {
			props: {
				call: call("weather__forecast", { city: "Boston", units: "metric" }),
				result: result('{"today":"rain"}'),
			},
		});
		expect(card(container).dataset.tool).toBe("weather__forecast");
		expect(summaryLine(container)).toContain("city: Boston");
		expect(container.textContent).toContain('"city": "Boston"');
		expect(container.textContent).toContain('{"today":"rain"}');
	});

	it("show a read's path and body", () => {
		const { container } = render(ToolCallBlock, {
			props: {
				call: call("read", { path: "src/greet.ts", offset: 10, limit: 5 }),
				result: result("export function greet() {}"),
			},
		});
		expect(summaryLine(container)).toContain("greet.ts");
		expect(summaryLine(container)).toContain("offset 10");
		expect(container.textContent).toContain("export function greet() {}");
	});

	it("show the image a read returned, not just its note", () => {
		// Pi's read tool answers an image path with a text note plus an image
		// block (pi-coding-agent/dist/core/tools/read.js). A text-only card
		// rendered that as blank.
		const { container } = render(ToolCallBlock, {
			props: {
				call: call("read", { path: "shot.png" }),
				result: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", mimeType: "image/png", data: "AAAA" },
					],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage,
			},
		});
		expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
	});

	it("show a write's content and size", () => {
		const { container } = render(ToolCallBlock, {
			props: {
				call: call("write", { path: "a/b/notes.md", content: "one\ntwo\nthree" }),
				result: result("Successfully wrote 13 bytes to a/b/notes.md"),
			},
		});
		expect(summaryLine(container)).toContain("notes.md");
		expect(summaryLine(container)).toContain("3 lines");
		expect(container.textContent).toContain("one\ntwo\nthree");
	});
});

describe("the edit card", () => {
	/** Pi's real argument shape -- `{ path, edits: [...] }`, not flat. */
	const piEdit = call("edit", {
		path: "src/greet.ts",
		edits: [
			{ oldText: 'return "hello";', newText: "return `hello ${name}`;" },
			{ oldText: "greet();", newText: 'greet("world");' },
		],
	});

	it("renders a diff for Pi's nested edits", () => {
		const { container } = render(ToolCallBlock, {
			props: {
				call: piEdit,
				result: result("Successfully replaced 2 block(s) in src/greet.ts."),
			},
		});
		const added = [...container.querySelectorAll(".line.add .text")].map((e) => e.textContent);
		const removed = [...container.querySelectorAll(".line.del .text")].map((e) => e.textContent);
		expect(removed).toEqual(['return "hello";', "greet();"]);
		expect(added).toEqual(["return `hello ${name}`;", 'greet("world");']);
	});

	it("counts every hunk in the summary", () => {
		const { container } = render(ToolCallBlock, { props: { call: piEdit } });
		expect(summaryLine(container)).toContain("greet.ts");
		expect(summaryLine(container)).toContain("+2 −2"); // two hunks, one line each way
	});

	it("renders a diff for the flat shape too", () => {
		const { container } = render(ToolCallBlock, {
			props: {
				call: call("edit", {
					file_path: "src/greet.ts",
					old_string: "hello",
					new_string: "goodbye",
				}),
			},
		});
		expect(container.querySelector(".line.add .text")?.textContent).toBe("goodbye");
		expect(container.querySelector(".line.del .text")?.textContent).toBe("hello");
	});

	it("still names the file when the arguments are a shape it cannot read", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("edit", { path: "src/greet.ts", patch: "@@ -1 +1 @@" }) },
		});
		expect(summaryLine(container)).toContain("greet.ts");
		expect(container.querySelectorAll(".line").length).toBe(0);
	});
});
