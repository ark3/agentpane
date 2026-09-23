/**
 * The Emacs node projection, driven by the same recorded turns the adapters
 * are tested on. Structure only -- indices, roles, part kinds, diff line
 * types -- never model wording, which varies per capture.
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { PaneMessage } from "$shared/protocol.ts";
import { ClaudeReducer } from "$server/adapters/claude/reducer.ts";
import {
	readFixture as readClaudeFixture,
	type FixtureName as ClaudeFixtureName,
} from "$server/adapters/claude/test-support.ts";
import { CodexReducer } from "$server/adapters/codex/reducer.ts";
import {
	readFixture as readCodexFixture,
	type FixtureName as CodexFixtureName,
} from "$server/adapters/codex/test-support.ts";
import { toolSummary } from "$client/render/tools/summary.ts";
import { projectTranscript, projectUpsert } from "./nodes.ts";
import type { TextPart, ToolPart, TranscriptNode } from "./protocol.ts";
import { loadRenderer } from "./render.ts";

/** A stand-in for `renderMarkdown`: the structure tests only need to see it was called with the part's text. */
const render = (markdown: string): string => `stub:${markdown}`;

function replayClaude(name: ClaudeFixtureName): PaneMessage[] {
	const reducer = new ClaudeReducer({ now: () => 1_000 });
	for (const line of readClaudeFixture(name)) reducer.handle(line);
	return reducer.getState().messages;
}

function replayCodex(name: CodexFixtureName): PaneMessage[] {
	const reducer = new CodexReducer({ now: () => 1_000 });
	for (const line of readCodexFixture(name)) reducer.handle(line);
	return reducer.getState().messages;
}

function toolParts(nodes: TranscriptNode[]): ToolPart[] {
	return nodes.flatMap((node) => node.parts.filter((part): part is ToolPart => part.type === "tool"));
}

/** The indices a transcript's visible entries should keep: every message except a result whose call is present. */
function expectedIndices(messages: PaneMessage[]): number[] {
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") answered.add(block.id);
	}
	const indices: number[] = [];
	messages.forEach((message, index) => {
		if (message.role === "toolResult" && answered.has(message.toolCallId)) return;
		indices.push(index);
	});
	return indices;
}

describe.each([
	["claude", "tool-use", replayClaude("tool-use")],
	["claude", "compact", replayClaude("compact")],
	["codex", "tool-edit", replayCodex("tool-edit")],
	["codex", "tool-read", replayCodex("tool-read")],
] as const)("replaying %s %s", (_backend, _name, messages) => {
	const nodes = projectTranscript(messages, false, render);

	it("yields one node per visible entry, in order, keyed by the original index", () => {
		const indices = nodes.map((node) => node.index);
		expect(indices).toEqual(expectedIndices(messages));
		// Something was folded: the fixture has tool results, and none survives as a node.
		expect(indices.length).toBeLessThan(messages.length);
		expect(nodes.some((node) => node.role === "tool-result")).toBe(false);
	});

	it("maps roles and carries every folded result on its call", () => {
		for (const node of nodes) {
			const message = messages[node.index]!;
			expect(node.role).toBe(message.role === "toolResult" ? "tool-result" : message.role);
			if (message.role === "assistant") expect(node.meta).toBeDefined();
			else expect(node.meta).toBeUndefined();
		}
		const parts = toolParts(nodes);
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) {
			expect(part.state).toBe("ok");
			expect(part.result).not.toBe("");
			expect(part.args).not.toBe("");
		}
	});
});

describe("tool parts", () => {
	it("gives a Claude Edit call a diff with add and del lines", () => {
		const edits = toolParts(projectTranscript(replayClaude("tool-use"), false, render)).filter(
			(part) => part.name.toLowerCase() === "edit",
		);
		expect(edits.length).toBeGreaterThan(0);
		for (const part of edits) {
			const types = new Set(part.diff?.map((line) => line.type));
			expect(types.has("add")).toBe(true);
			expect(types.has("del")).toBe(true);
		}
	});

	it("gives a Codex fileChange, mapped to edit with nested hunks, a diff too", () => {
		const edits = toolParts(projectTranscript(replayCodex("tool-edit"), false, render)).filter((part) => part.name === "edit");
		expect(edits.length).toBeGreaterThan(0);
		for (const part of edits) {
			expect(part.diff?.length).toBeGreaterThan(0);
			expect(part.diff?.some((line) => line.type === "add" || line.type === "del")).toBe(true);
		}
	});

	it("gives a Read call no diff and a non-empty summary", () => {
		const reads = toolParts(projectTranscript(replayClaude("tool-use"), false, render)).filter(
			(part) => part.name.toLowerCase() === "read",
		);
		expect(reads.length).toBeGreaterThan(0);
		for (const part of reads) {
			expect(part.diff).toBeUndefined();
			expect(part.summary).not.toBe("");
		}
	});

	it("gives a Codex subagent call the header the browser card shows", () => {
		// `toolSummary` is the one vocabulary, so the node has to read as the
		// card does: the collab operation, then each child thread's short id.
		const messages = replayCodex("subagent");
		const calls = new Map<string, ToolCall>();
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block);
		}
		const parts = toolParts(projectTranscript(messages, false, render)).filter((part) => part.name === "subagent");
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) {
			const call = [...calls.values()].find((candidate) => toolSummary(candidate) === part.summary);
			if (!call) throw new Error(`no subagent call summarises as ${JSON.stringify(part.summary)}`);
			const tool = call.arguments["tool"];
			if (typeof tool !== "string") throw new Error("subagent call without a tool argument");
			expect(part.summary.startsWith(tool)).toBe(true);
			const threadIds = call.arguments["threadIds"];
			if (!Array.isArray(threadIds)) continue;
			for (const id of threadIds) {
				if (typeof id !== "string") continue;
				expect(part.summary).toContain(id.slice(0, 8));
			}
		}
	});

	it("keeps an orphan result as its own tool-result node", () => {
		const messages = replayClaude("tool-use");
		const result = messages.find((message) => message.role === "toolResult");
		if (!result) throw new Error("tool-use fixture has no tool result");
		const nodes = projectTranscript([result], false, render);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ index: 0, role: "tool-result" });
		expect(nodes[0]!.parts).toHaveLength(1);
		expect(nodes[0]!.parts[0]).toMatchObject({ type: "tool", state: "ok", args: "" });
		expect(nodes[0]!.parts[0]).toMatchObject({ timestamp: result.timestamp });
		expect("timestamp" in nodes[0]!).toBe(false);
	});

	it("carries each folded result's timestamp on its call's part, and none before a result arrives", () => {
		const messages = replayClaude("tool-use");
		const results = new Map<string, ToolResultMessage>();
		for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
		const nodes = projectTranscript(messages, false, render);
		let checked = 0;
		for (const node of nodes) {
			const message = messages[node.index]!;
			if (message.role !== "assistant") continue;
			message.content.forEach((block, i) => {
				if (block.type !== "toolCall") return;
				const part = node.parts[i] as ToolPart;
				expect(part.timestamp).toBe(results.get(block.id)?.timestamp);
				checked += 1;
			});
		}
		expect(checked).toBeGreaterThan(0);

		const callIndex = messages.findIndex(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
		);
		for (const part of toolParts(projectTranscript(messages.slice(0, callIndex + 1), true, render))) {
			expect("timestamp" in part).toBe(false);
		}
	});

	it("carries a result's image parts on its call's part, and on an orphan's", () => {
		const messages = replayClaude("tool-use");
		const resultIndex = messages.findIndex((message) => message.role === "toolResult");
		const result = messages[resultIndex] as ToolResultMessage;
		const withImage: ToolResultMessage = {
			...result,
			content: [...result.content, { type: "image", mimeType: "image/png", data: "AAAA" }],
		};
		const edited = messages.slice();
		edited[resultIndex] = withImage;
		const image = { type: "image", mimeType: "image/png", data: "AAAA" };

		const parts = toolParts(projectTranscript(edited, false, render));
		const carrying = parts.filter((part) => part.images !== undefined);
		expect(carrying).toHaveLength(1);
		expect(carrying[0]!.images).toEqual([image]);

		const [orphan] = projectTranscript([withImage], false, render);
		expect((orphan!.parts[0] as ToolPart).images).toEqual([image]);
		// A result with no image parts carries no `images` at all.
		expect("images" in (projectTranscript([result], false, render)[0]!.parts[0] as ToolPart)).toBe(false);
	});

	it("marks a call running only while the session streams and its turn is the last visible entry", () => {
		const messages = replayClaude("tool-use");
		const callIndex = messages.findIndex(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
		);
		const call = messages[callIndex] as AssistantMessage;
		// The result's slot is still empty, so the call is the last visible entry.
		const upToCall = messages.slice(0, callIndex + 1);

		const running = toolParts(projectTranscript(upToCall, true, render));
		expect(running.length).toBeGreaterThan(0);
		for (const part of running) expect(part.state).toBe("running");

		for (const part of toolParts(projectTranscript(upToCall, false, render))) expect(part.state).toBe("ok");

		// Streaming, but a later turn is the tail: an earlier call is never running.
		const whole = projectTranscript(messages, true, render);
		const earlier = whole.find((node) => node.index === callIndex)!;
		for (const part of earlier.parts) if (part.type === "tool") expect(part.state).toBe("ok");

		// The upsert path reads the same two facts.
		expect(toolParts([projectUpsert(upToCall.slice(0, -1), callIndex, call, true, render)])[0]?.state).toBe("running");
		expect(toolParts([projectUpsert(upToCall.slice(0, -1), callIndex, call, false, render)])[0]?.state).toBe("ok");
	});
});

describe("assistant turns", () => {
	it("yields a thinking part for a thinking block", () => {
		const messages = replayClaude("thinking");
		const nodes = projectTranscript(messages, false, render);
		const thinking = nodes.flatMap((node) => node.parts.filter((part) => part.type === "thinking"));
		expect(thinking.length).toBeGreaterThan(0);
		for (const part of thinking) {
			expect(part).toMatchObject({ type: "thinking", redacted: false });
			expect(part.text).not.toBe("");
		}
	});

	it("keeps part order as block order", () => {
		const messages = replayClaude("tool-use");
		for (const node of projectTranscript(messages, false, render)) {
			const message = messages[node.index]!;
			if (message.role !== "assistant") continue;
			const kinds = message.content.map((block) => (block.type === "toolCall" ? "tool" : block.type));
			expect(node.parts.map((part) => part.type)).toEqual(kinds);
		}
	});

	it("says so in the meta line when a turn was aborted", () => {
		const messages = replayClaude("interrupt");
		const nodes = projectTranscript(messages, false, render);
		const last = nodes.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last?.meta?.stopReason).toBe("aborted");
	});

	it("omits stopReason from the meta of a turn that finished normally", () => {
		const messages = replayCodex("text");
		const turn = projectTranscript(messages, false, render).find((node) => node.role === "assistant");
		expect(turn?.meta).toBeDefined();
		expect(turn?.meta?.stopReason).toBeUndefined();
		expect(turn?.meta?.usage.totalTokens).toBeGreaterThan(0);
	});

	it("carries the model, effort and error message where the turn has them", () => {
		const base = replayCodex("text").find((m) => m.role === "assistant") as AssistantMessage;
		const turn = {
			...base,
			effort: "high",
			stopReason: "error",
			errorMessage: "boom",
		} as PaneMessage;
		const [node] = projectTranscript([turn], false, render);
		expect(node?.meta).toMatchObject({
			model: base.model,
			effort: "high",
			stopReason: "error",
			errorMessage: "boom",
		});
	});

	it("drops errorMessage from an aborted turn: the banner for aborted is fixed wording", () => {
		const base = replayClaude("interrupt").find((m) => m.role === "assistant") as AssistantMessage;
		expect(base.stopReason).toBe("aborted");
		const [node] = projectTranscript([{ ...base, errorMessage: "boom" } as PaneMessage], false, render);
		expect(node?.meta?.stopReason).toBe("aborted");
		expect(node?.meta?.errorMessage).toBeUndefined();
	});
});

describe("timestamps", () => {
	it("carries the message's own timestamp on every user and assistant node, and on no other", () => {
		for (const messages of [replayClaude("compact"), replayCodex("text"), replayCodex("tool-read")]) {
			const nodes = projectTranscript(messages, false, render);
			const timed = nodes.filter((node) => node.role === "user" || node.role === "assistant");
			expect(timed.length).toBeGreaterThan(0);
			for (const node of nodes) {
				if (timed.includes(node)) expect(node.timestamp).toBe(messages[node.index]!.timestamp);
				else expect("timestamp" in node).toBe(false);
			}
		}
	});

	it("omits a timestamp a preview could not read, rather than sending null", () => {
		const messages = replayCodex("text").map((message) => ({ ...message, timestamp: Number.NaN }) as PaneMessage);
		const nodes = projectTranscript(messages, false, render);
		expect(nodes.length).toBeGreaterThan(0);
		for (const node of nodes) expect("timestamp" in node).toBe(false);
	});
});

describe("text parts", () => {
	function textParts(nodes: TranscriptNode[]): TextPart[] {
		return nodes.flatMap((node) => node.parts.filter((part): part is TextPart => part.type === "text"));
	}

	it("fills html from the renderer it is given, on every text part and nothing else", () => {
		const messages = replayClaude("tool-use");
		const nodes = projectTranscript(messages, false, render);
		const parts = textParts(nodes);
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) expect(part.html).toBe(`stub:${part.text}`);
		for (const node of nodes) {
			for (const part of node.parts) if (part.type !== "text") expect("html" in part).toBe(false);
		}
		const tail = messages.length - 1;
		const upserted = projectUpsert(messages.slice(0, tail), tail, messages[tail]!, false, render);
		for (const part of textParts([upserted])) expect(part.html).toBe(`stub:${part.text}`);
	});

	it("carries the browser's own HTML when given the real renderer", async () => {
		const real = await loadRenderer();
		const parts = textParts(projectTranscript(replayClaude("tool-use"), false, real)).filter(
			(part) => part.text !== "",
		);
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) {
			expect(part.html.length).toBeGreaterThan(0);
			expect(part.html).not.toBe(part.text);
		}
	});
});

describe("other roles", () => {
	it("yields a compactionSummary node with its summary as text and its tokensBefore", () => {
		const messages = replayClaude("compact");
		const nodes = projectTranscript(messages, false, render);
		const marker = nodes.find((node) => node.role === "compactionSummary");
		expect(marker).toBeDefined();
		expect(marker!.meta).toBeUndefined();
		expect(marker!.parts.every((part) => part.type === "text")).toBe(true);
		const message = messages[marker!.index]!;
		if (message.role !== "compactionSummary") throw new Error("marker is not a compactionSummary");
		expect(message.tokensBefore).toBeGreaterThan(0);
		expect(marker!.tokensBefore).toBe(message.tokensBefore);
	});

	it("yields a user node with text and image parts in order", () => {
		const user = replayCodex("text").find((message) => message.role === "user");
		if (!user) throw new Error("text fixture has no user message");
		const withImage = {
			...user,
			content: [
				{ type: "text", text: typeof user.content === "string" ? user.content : "" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		} as PaneMessage;
		const [node] = projectTranscript([withImage], false, render);
		expect(node?.role).toBe("user");
		expect(node?.parts.map((part) => part.type)).toEqual(["text", "image"]);
		expect(node?.parts[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "AAAA" });
	});
});

describe("streaming upserts", () => {
	it("maps a sequence of tail upserts to nodes whose last text part ends at the final text", () => {
		const messages = replayCodex("text");
		const tail = messages.length - 1;
		const final = messages[tail] as AssistantMessage;
		const finalText = final.content.find((block) => block.type === "text");
		if (finalText?.type !== "text") throw new Error("text fixture's final turn has no text");
		const before = messages.slice(0, tail);

		const steps = [1, Math.floor(finalText.text.length / 2), finalText.text.length];
		const upserts: PaneMessage[] = steps.map((length, i) => ({
			...final,
			content: [{ type: "text", text: finalText.text.slice(0, length) }],
			stopReason: i === steps.length - 1 ? final.stopReason : "pending",
		})) as PaneMessage[];

		const nodes = upserts.map((message) => projectUpsert(before, tail, message, true, render));
		expect(nodes).toHaveLength(upserts.length);
		for (const node of nodes) expect(node.index).toBe(tail);

		const lastText = (node: TranscriptNode) =>
			[...node.parts].reverse().find((part): part is TextPart => part.type === "text")?.text;
		expect(nodes.map(lastText)).toEqual(steps.map((length) => finalText.text.slice(0, length)));
		expect(lastText(nodes.at(-1)!)).toBe(finalText.text);
	});

	it("returns the call's node, not a result node, when the upsert is a folded result", () => {
		const messages = replayClaude("tool-use");
		const resultIndex = messages.findIndex((message) => message.role === "toolResult");
		const result = messages[resultIndex]!;
		const callIndex = messages.findIndex(
			(message) =>
				message.role === "assistant" &&
				result.role === "toolResult" &&
				message.content.some((block) => block.type === "toolCall" && block.id === result.toolCallId),
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);

		const before = messages.slice(0, resultIndex);
		const node = projectUpsert(before, resultIndex, result, true, render);
		expect(node.index).toBe(callIndex);
		expect(node.role).toBe("assistant");
		const part = node.parts.find((p): p is ToolPart => p.type === "tool" && p.result !== "");
		expect(part).toBeDefined();
	});

	it("rejects an index past the end of the transcript", () => {
		const messages = replayCodex("text");
		const message = messages.at(-1)!;
		expect(() => projectUpsert(messages, messages.length + 1, message, false, render)).toThrow(RangeError);
		expect(() => projectUpsert(messages, -1, message, false, render)).toThrow(RangeError);
	});

	it("leaves the transcript it was given untouched", () => {
		const messages = replayCodex("text");
		const copy = structuredClone(messages);
		projectUpsert(messages, messages.length, messages.at(-1)!, false, render);
		expect(messages).toEqual(copy);
	});
});
