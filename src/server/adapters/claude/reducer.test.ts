/**
 * The Claude Code mapping, driven by real recorded sessions.
 *
 * Everything here asserts on **structure** -- event sequence, roles, content
 * block kinds, correlation by id -- and never on model wording, which varies
 * per capture. Where a test needs a concrete string it reads it back out of
 * the same fixture rather than hardcoding one.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { ClaudeReducer, type ClaudeEffect } from "./reducer.ts";
import { isRecord, type ClaudeEvent } from "./protocol.ts";
import {
	assistantMessageIds,
	authoritativeBlocks,
	censusKey,
	readFixture,
	readFixtureMeta,
	type FixtureName,
} from "./test-support.ts";

const FIXTURES: FixtureName[] = ["text-turn", "thinking", "tool-use", "compact", "interrupt"];

/**
 * Expected roles per fixture. The human prompt is NOT among them: the CLI
 * never echoes it (it is added locally by `beginTurn`, covered separately).
 */
const EXPECTED_ROLES: Record<string, AgentMessage["role"][]> = {
	"text-turn": ["assistant"],
	thinking: ["assistant"],
	"tool-use": ["assistant", "toolResult", "toolResult", "assistant", "toolResult", "assistant"],
	compact: ["assistant", "assistant", "toolResult", "assistant", "compactionSummary"],
	interrupt: ["assistant"],
};

/** Events that must be ancillary: consumed with no transcript effect at all. */
function isAncillary(event: ClaudeEvent): boolean {
	const key = censusKey(event);
	return key === "rate_limit_event" || key === "system:thinking_tokens";
}

function replay(name: FixtureName, stopBefore?: (line: ClaudeEvent) => boolean) {
	const reducer = new ClaudeReducer({ now: () => 1_000 });
	const effects: ClaudeEffect[] = [];
	for (const line of readFixture(name)) {
		if (stopBefore?.(line)) break;
		effects.push(...reducer.handle(line));
	}
	return { reducer, effects, ...reducer.getState() };
}

function isAssistant(message: AgentMessage | undefined): message is AssistantMessage {
	return message?.role === "assistant";
}

function toolCallsOf(messages: AgentMessage[]): ToolCall[] {
	return messages
		.filter(isAssistant)
		.flatMap((message) => message.content)
		.filter((block): block is ToolCall => block.type === "toolCall");
}

describe.each(FIXTURES)("replaying the %s fixture", (name) => {
	it("produces the expected roles in order", () => {
		const { messages } = replay(name);
		expect(messages.map((message) => message.role)).toEqual(EXPECTED_ROLES[name]);
	});

	it("merges assistant events by API message id: one message per id", () => {
		const lines = readFixture(name);
		const { messages } = replay(name);
		const assistants = messages.filter(isAssistant);
		expect(assistants.length).toBe(assistantMessageIds(lines).length);
	});

	it("drives every captured line and matches the recorded census", () => {
		const lines = readFixture(name);
		const meta = readFixtureMeta(name);
		expect(lines).toHaveLength(meta.lines);
		const census: Record<string, number> = {};
		for (const line of lines) {
			const key = censusKey(line);
			census[key] = (census[key] ?? 0) + 1;
		}
		expect(census).toEqual(meta.event_census);

		const ancillary = lines.filter(isAncillary);
		expect(ancillary.length).toBeGreaterThan(0);
		const isolated = new ClaudeReducer({ now: () => 1 });
		for (const line of ancillary) expect(isolated.handle(line)).toEqual([]);
	});

	it("ends the turn only at result: streaming goes true then false", () => {
		const { effects, isStreaming } = replay(name);
		const streaming = effects.filter((e) => e.type === "streaming");
		expect(streaming[0]).toEqual({ type: "streaming", isStreaming: true });
		expect(streaming.at(-1)).toEqual({ type: "streaming", isStreaming: false });
		expect(isStreaming).toBe(false);
	});

	it("emits changed indices that address real messages", () => {
		const { effects, messages } = replay(name);
		const indices = effects.filter((e) => e.type === "message").map((e) => e.index);
		expect(indices.length).toBeGreaterThan(0);
		for (const index of indices) {
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(messages.length);
		}
	});

	it("stamps every assistant message with model identity and usage", () => {
		const { messages } = replay(name);
		const assistants = messages.filter(isAssistant);
		expect(assistants.length).toBeGreaterThan(0);
		for (const message of assistants) {
			expect(message.api).toBe("claude-code");
			expect(message.provider).toBe("anthropic");
			expect(message.model.length).toBeGreaterThan(0);
			expect(message.usage.totalTokens).toBeGreaterThanOrEqual(0);
		}
	});

	it("renders thinking blocks (Haiku emits them on every headless turn)", () => {
		const { messages } = replay(name);
		const thinking = messages
			.filter(isAssistant)
			.flatMap((m) => m.content)
			.filter((block) => block.type === "thinking");
		expect(thinking.length).toBeGreaterThan(0);
		for (const block of thinking) expect(block.thinking.length).toBeGreaterThan(0);
	});
});

describe("streaming assembly (text-turn fixture)", () => {
	const lines = readFixture("text-turn");
	const finalTexts = authoritativeBlocks(lines, "text").map((block) => block.text as string);
	const finalThinking = authoritativeBlocks(lines, "thinking");

	function textDeltas(): string[] {
		const out: string[] = [];
		for (const line of lines) {
			if (line.type !== "stream_event") continue;
			const body = (line as { event?: { type?: string; delta?: { type?: string; text?: string } } })
				.event;
			if (body?.type === "content_block_delta" && body.delta?.type === "text_delta") {
				out.push(body.delta.text ?? "");
			}
		}
		return out;
	}

	it("assembles streamed text deltas before any authoritative event arrives", () => {
		let sawTextDelta = false;
		const { messages } = replay("text-turn", (line) => {
			if (sawTextDelta && line.type === "assistant") return true;
			if (line.type === "stream_event") {
				const body = (line as { event?: { type?: string; delta?: { type?: string } } }).event;
				if (body?.type === "content_block_delta" && body.delta?.type === "text_delta") {
					sawTextDelta = true;
				}
			}
			return false;
		});
		const last = messages.at(-1);
		expect(isAssistant(last)).toBe(true);
		const text = last && isAssistant(last) ? last.content.find((b) => b.type === "text") : undefined;
		expect(text?.type).toBe("text");
		expect(text && text.type === "text" && text.text).toBe(textDeltas().join(""));
	});

	it("replaces streamed content with the authoritative block text", () => {
		const { messages } = replay("text-turn");
		const rendered = messages
			.filter(isAssistant)
			.flatMap((m) => m.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text);
		expect(finalTexts.length).toBeGreaterThan(0);
		expect(rendered).toEqual(finalTexts);
		// The capture agrees with itself: the deltas sum to the final text.
		expect(textDeltas().join("")).toBe(finalTexts.join(""));
	});

	it("carries the thinking signature through to the rendered block", () => {
		const { messages } = replay("text-turn");
		const thinking = messages
			.filter(isAssistant)
			.flatMap((m) => m.content)
			.filter((block) => block.type === "thinking");
		expect(thinking).toHaveLength(finalThinking.length);
		const signature = finalThinking[0]?.signature;
		expect(typeof signature).toBe("string");
		expect(thinking[0]?.thinkingSignature).toBe(signature);
	});
});

describe("tool use (tool-use fixture)", () => {
	const lines = readFixture("tool-use");
	const authoritative = authoritativeBlocks(lines, "tool_use");

	it("renders every tool_use block as a toolCall with its authoritative input", () => {
		const { messages } = replay("tool-use");
		const calls = toolCallsOf(messages);
		expect(calls.length).toBe(authoritative.length);
		for (const [i, call] of calls.entries()) {
			const expected = authoritative[i];
			expect(call.id).toBe(expected?.id);
			expect(call.name).toBe(expected?.name);
			expect(call.arguments).toEqual(expected?.input);
		}
	});

	it("streams tool input via input_json_delta before the authoritative event", () => {
		// Stop just before the first assistant event that carries a tool_use
		// block: by then the deltas for that block have all arrived.
		const { messages } = replay("tool-use", (line) => {
			if (line.type !== "assistant") return false;
			const content = line.message?.content;
			return Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_use");
		});
		const calls = toolCallsOf(messages);
		expect(calls.length).toBe(1);
		expect(calls[0]?.arguments).toEqual(authoritative[0]?.input);
	});

	it("correlates tool results back to their calls by tool_use_id", () => {
		const { messages } = replay("tool-use");
		const calls = new Map(toolCallsOf(messages).map((call) => [call.id, call]));
		const results = messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(results.length).toBe(calls.size);
		for (const result of results) {
			const call = calls.get(result.toolCallId);
			expect(call).toBeDefined();
			expect(result.toolName).toBe(call?.name);
			expect(result.isError).toBe(false);
			expect(result.content.length).toBeGreaterThan(0);
		}
	});

	it("keeps the tool argument shapes the client's bespoke renderers expect", () => {
		// Structure, not wording: key sets, per render/tools/args.ts.
		const { messages } = replay("tool-use");
		const byName = new Map(toolCallsOf(messages).map((call) => [call.name, call]));
		expect(Object.keys(byName.get("Bash")?.arguments ?? {}).sort()).toEqual([
			"command",
			"description",
		]);
		expect(Object.keys(byName.get("Read")?.arguments ?? {})).toEqual(["file_path"]);
		expect(Object.keys(byName.get("Edit")?.arguments ?? {}).sort()).toEqual([
			"file_path",
			"new_string",
			"old_string",
			"replace_all",
		]);
	});
});

describe("interrupt (interrupt fixture)", () => {
	it("treats error_during_execution as aborted, not as a failure", () => {
		const { effects, messages, isStreaming } = replay("interrupt");
		expect(effects.filter((e) => e.type === "error")).toEqual([]);
		expect(isStreaming).toBe(false);
		const last = messages.at(-1);
		expect(isAssistant(last)).toBe(true);
		expect(last && isAssistant(last) && last.stopReason).toBe("aborted");
	});

	it("keeps the partial streamed content the interrupt cut short", () => {
		const { messages } = replay("interrupt");
		const last = messages.at(-1);
		if (!last || !isAssistant(last)) throw new Error("no assistant message");
		expect(last.content.map((block) => block.type)).toEqual(["thinking", "text"]);
	});

	it("does not render the injected interruption notice as a human turn", () => {
		const { messages } = replay("interrupt");
		expect(messages.filter((message) => message.role === "user")).toEqual([]);
	});
});

describe("compaction (compact fixture)", () => {
	const lines = readFixture("compact");
	const boundary = lines.find(
		(line): line is Extract<ClaudeEvent, { type: "system" }> =>
			line.type === "system" && (line as { subtype?: string }).subtype === "compact_boundary",
	);
	const synthetic = lines.find(
		(line): line is Extract<ClaudeEvent, { type: "user" }> =>
			line.type === "user" && (line as { isSynthetic?: boolean }).isSynthetic === true,
	);

	it("reduces compact_boundary to a compactionSummary marker with pre_tokens", () => {
		const { messages } = replay("compact");
		const marker = messages.find((message) => message.role === "compactionSummary");
		expect(marker).toBeDefined();
		const meta = (boundary as { compact_metadata?: { pre_tokens?: number } } | undefined)
			?.compact_metadata;
		expect(typeof meta?.pre_tokens).toBe("number");
		expect((marker as { tokensBefore: number }).tokensBefore).toBe(meta?.pre_tokens);
	});

	it("routes the synthetic summary user message into the marker, not the transcript", () => {
		const { messages } = replay("compact");
		const marker = messages.find((message) => message.role === "compactionSummary");
		const summaryText =
			typeof synthetic?.message?.content === "string" ? synthetic.message.content : "";
		expect(summaryText.length).toBeGreaterThan(0);
		expect((marker as { summary: string }).summary).toBe(summaryText.trim());
		// Neither the summary nor the <local-command-stdout> replay renders as
		// something a human said.
		expect(messages.filter((message) => message.role === "user")).toEqual([]);
	});

	it("does not reset the transcript on the re-init the compaction emits", () => {
		const inits = lines.filter(
			(line) => line.type === "system" && (line as { subtype?: string }).subtype === "init",
		);
		expect(inits.length).toBeGreaterThan(1);
		const { messages } = replay("compact");
		expect(messages.length).toBeGreaterThan(1);
	});

	it("enters running once and clears it in the marker update", () => {
		const reducer = new ClaudeReducer({ now: () => 1_000 });
		const transitions: { compaction: string | null; effects: ClaudeEffect[] }[] = [];
		let previous = reducer.getState().compaction;
		for (const line of lines) {
			const effects = reducer.handle(line);
			const current = reducer.getState().compaction;
			if (current !== previous) transitions.push({ compaction: current, effects });
			previous = current;
		}
		expect(transitions.map(({ compaction }) => compaction)).toEqual(["running", null]);
		expect(transitions[1]?.effects).toContainEqual({ type: "message", index: expect.any(Number) });
	});
});

describe("local prompt and hydration", () => {
	it("beginTurn appends the local user message and starts streaming", () => {
		const reducer = new ClaudeReducer({ now: () => 42 });
		const effects = reducer.beginTurn("run the tests", [
			{ mimeType: "image/png", base64: "iVBORw0=" },
		]);
		expect(effects).toEqual([
			{ type: "message", index: 0 },
			{ type: "streaming", isStreaming: true },
		]);
		expect(reducer.getState().messages[0]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "run the tests" },
				{ type: "image", data: "iVBORw0=", mimeType: "image/png" },
			],
			timestamp: 42,
		});
	});

	it("hydrates store records through the same merge paths as the live stream", () => {
		const reducer = new ClaudeReducer({ now: () => 1 });
		const effects = reducer.hydrate([
			{
				type: "user",
				uuid: "u1",
				timestamp: "2026-08-25T12:00:00.000Z",
				message: { role: "user", content: "stored prompt" },
			},
			{
				type: "assistant",
				uuid: "a1",
				timestamp: "2026-08-25T12:00:01.000Z",
				message: {
					id: "msg_1",
					role: "assistant",
					model: "m",
					content: [{ type: "thinking", thinking: "stored thought", signature: "sig" }],
				},
			},
			{
				type: "assistant",
				uuid: "a2",
				timestamp: "2026-08-25T12:00:02.000Z",
				message: {
					id: "msg_1",
					role: "assistant",
					model: "m",
					content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }],
				},
			},
			{
				type: "user",
				uuid: "u2",
				timestamp: "2026-08-25T12:00:03.000Z",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: "1\tstored" }],
				},
				toolUseResult: { file: { filePath: "/x" } },
			},
		]);

		expect(effects).toEqual([{ type: "reset" }]);
		const { messages, isStreaming } = reducer.getState();
		expect(isStreaming).toBe(false);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		// Both assistant records merged into one message under msg_1.
		const assistant = messages[1] as AssistantMessage;
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
		const result = messages[2] as ToolResultMessage;
		expect(result.toolCallId).toBe("t1");
		expect(result.toolName).toBe("Read");
		expect(result.details).toEqual({ file: { filePath: "/x" } });
	});
});
