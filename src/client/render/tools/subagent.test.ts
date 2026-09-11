/**
 * The subagent card (OW-benige): the parent transcript's only trace of a
 * child thread.
 *
 * OW-fafeja took the child's items out of the parent, so what is asserted
 * here is the replacement's whole job -- name the operation, name the child
 * thread, and offer the door into it. The child's conversation is
 * deliberately not inlined; a subagent can run for minutes, and a nested
 * transcript would bury the parent exactly the way OW-fafeja fixed.
 */
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "$shared/protocol.ts";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import ToolCallBlock from "../ToolCallBlock.svelte";
import { CODEX_TOOL_NAMES } from "$server/adapters/codex/mapping.ts";
import { resolveToolRenderer, defaultToolRenderer } from "./registry.ts";
import SubagentTool from "./SubagentTool.svelte";

const CHILD = "01a086ce-039d-7720-86cb-ceb8ec8f3774";

function call(tool: string, extra: Record<string, unknown> = {}): ToolCall {
	return {
		type: "toolCall",
		id: "exec-1",
		name: "subagent",
		arguments: { tool, threadIds: [CHILD], ...extra },
	};
}

function result(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "exec-1",
		toolName: "subagent",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("the subagent card", () => {
	it("is the registered renderer for the name the mapping actually emits", () => {
		// The registry key and `CODEX_TOOL_NAMES` are one seam described in two
		// files (the constant's own docblock says so), and nothing but this
		// assertion holds them together: rename the constant alone and every
		// subagent card silently falls back to `DefaultTool`. Reaching across
		// into `$server` is a test-only import -- no client module does it, so
		// nothing follows it into the bundle.
		expect(resolveToolRenderer(CODEX_TOOL_NAMES.collabAgentToolCall)).toBe(SubagentTool);
		expect(resolveToolRenderer(CODEX_TOOL_NAMES.collabAgentToolCall)).not.toBe(defaultToolRenderer);
	});

	it("names the operation and the child thread, and shows the child's reply", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("wait"), result: result("Hello! How can I help?") },
		});
		const card = container.querySelector("details.tool");
		expect(card?.textContent).toContain("wait");
		expect(card?.textContent).toContain(CHILD);
		expect(card?.textContent).toContain("Hello! How can I help?");
		// Collapsed like every other tool card (D5).
		expect((card as HTMLDetailsElement).open).toBe(false);
	});

	it("shows the spawn prompt", () => {
		const { container } = render(ToolCallBlock, {
			props: { call: call("spawnAgent", { prompt: "Please reply with a short greeting." }) },
		});
		expect(container.textContent).toContain("Please reply with a short greeting.");
	});

	it("opens the child thread as its own session", async () => {
		const onopensession = vi.fn<(ref: SessionRef) => void>();
		const { container } = render(ToolCallBlock, {
			props: { call: call("wait"), result: result("done"), onopensession },
		});
		const open = container.querySelector<HTMLButtonElement>("button.open-thread");
		if (!open) throw new Error("no open-thread control rendered");
		open.click();
		expect(onopensession).toHaveBeenCalledWith({ backend: "codex", id: CHILD });
	});

	it("offers no control when the shell passed no way to open one", () => {
		// `ToolRenderProps` is shared by every renderer and most tools name no
		// session, so the handler is optional and this card has to read as fine
		// without it.
		const { container } = render(ToolCallBlock, { props: { call: call("wait") } });
		expect(container.querySelector("button.open-thread")).toBeNull();
	});

	it("draws no thread control before the spawn reports an id", () => {
		// `item/started` for a spawn carries an empty `receiverThreadIds`.
		const { container } = render(ToolCallBlock, {
			props: {
				call: { type: "toolCall", id: "exec-1", name: "subagent", arguments: { tool: "spawnAgent", threadIds: [] } },
				onopensession: vi.fn(),
			},
		});
		expect(container.querySelector("button.open-thread")).toBeNull();
	});
});
