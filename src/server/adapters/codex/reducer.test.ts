/**
 * The mapping, driven by real recorded turns.
 *
 * Everything here asserts on **structure** -- event sequence, item types,
 * content-block kinds, correlation by id -- and never on model wording, which
 * varies per capture. Where a test needs a concrete string it reads it back
 * out of the same fixture rather than hardcoding one. The scrubbed values
 * (`example-model`, `example-provider`) are never asserted on.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AssistantTurn } from "../../../shared/protocol.ts";
import { CODEX_TOOL_NAMES } from "./mapping.ts";
import { CodexReducer, type CodexEffect } from "./reducer.ts";
import { isRecord, type CodexServerMessage, type ThreadItem } from "./protocol.ts";
import {
	byMethod,
	itemOf,
	readFixture,
	readFixtureMeta,
	type FixtureName,
} from "./test-support.ts";

const FIXTURES: FixtureName[] = ["text", "tool-read", "tool-edit"];

const EXPECTED_ROLES: Record<FixtureName, AgentMessage["role"][]> = {
	text: ["user", "assistant"],
	"tool-read": ["user", "assistant", "assistant", "toolResult", "assistant"],
	"tool-edit": [
		"user",
		"assistant",
		"assistant",
		"toolResult",
		"assistant",
		"assistant",
		"toolResult",
		"assistant",
		"assistant",
		"toolResult",
		"assistant",
	],
};

const ANCILLARY_METHODS = new Set([
	"account/rateLimits/updated",
	"mcpServer/startupStatus/updated",
	"remoteControl/status/changed",
]);

function methodOf(line: CodexServerMessage): string | undefined {
	return "method" in line ? line.method : undefined;
}

function unsafeMessage(value: unknown): CodexServerMessage {
	return value as CodexServerMessage;
}

function startedItem(item: ThreadItem, startedAtMs: number): Extract<CodexServerMessage, { method: "item/started" }> {
	return {
		method: "item/started",
		params: { threadId: "t", turnId: "u", item, startedAtMs },
	};
}

function completedItem(
	item: ThreadItem,
	completedAtMs: number,
): Extract<CodexServerMessage, { method: "item/completed" }> {
	return {
		method: "item/completed",
		params: { threadId: "t", turnId: "u", item, completedAtMs },
	};
}

function replay(name: FixtureName, stopBefore?: (line: CodexServerMessage) => boolean) {
	const reducer = new CodexReducer({ now: () => 1_000 });
	const effects: CodexEffect[] = [];
	for (const line of readFixture(name)) {
		if (stopBefore?.(line)) break;
		effects.push(...reducer.handle(line));
	}
	return { reducer, effects, ...reducer.getState() };
}

/** How many messages each completed item is expected to contribute. */
function expectedMessageCount(name: FixtureName): number {
	const seen = new Set<string>();
	let total = 0;
	for (const line of byMethod(readFixture(name), "item/completed")) {
		const item = itemOf(line);
		const id = item.id;
		if (seen.has(id)) continue;
		seen.add(id);
		switch (item.type) {
			case "userMessage":
			case "agentMessage":
				total += 1;
				break;
			case "reasoning": {
				// Hidden reasoning (empty summary AND content) produces nothing.
				const parts = [...item.summary, ...item.content];
				total += parts.some((p) => p.trim()) ? 1 : 0;
				break;
			}
			case "commandExecution":
			case "fileChange":
				total += 2; // toolCall message + toolResult message
				break;
			default:
				break;
		}
	}
	return total;
}

function isAssistant(message: AgentMessage | undefined): message is AssistantTurn {
	return message?.role === "assistant";
}

function itemOfType<K extends ThreadItem["type"]>(
	items: ThreadItem[],
	type: K,
): Extract<ThreadItem, { type: K }> {
	const item = items.find(
		(candidate): candidate is Extract<ThreadItem, { type: K }> => candidate.type === type,
	);
	if (!item) throw new Error(`fixture has no ${type} item`);
	return item;
}

describe.each(FIXTURES)("replaying the %s fixture", (name) => {
	it("produces one message per item, in order, with no duplicates", () => {
		const { messages } = replay(name);
		expect(messages.length).toBe(expectedMessageCount(name));
		expect(messages.map((message) => message.role)).toEqual(EXPECTED_ROLES[name]);
	});

	it("drives every captured line and safely ignores ancillary census events", () => {
		const lines = readFixture(name);
		const meta = readFixtureMeta(name);
		const census: Record<string, number> = {};
		for (const line of lines) {
			const method = methodOf(line) ?? "<response>";
			census[method] = (census[method] ?? 0) + 1;
		}
		expect(lines).toHaveLength(meta.lines);
		expect(census).toEqual(meta.event_census);

		const ancillary = lines.filter((line) => ANCILLARY_METHODS.has(methodOf(line) ?? ""));
		expect(ancillary.length).toBeGreaterThan(0);
		const isolated = new CodexReducer({ now: () => 1 });
		for (const line of ancillary) expect(isolated.handle(line)).toEqual([]);
	});

	it("ends the turn: streaming goes true then false", () => {
		const { effects, isStreaming } = replay(name);
		const streamingEffects = effects.filter((e) => e.type === "streaming");
		expect(streamingEffects[0]).toEqual({ type: "streaming", isStreaming: true });
		expect(streamingEffects.at(-1)).toEqual({ type: "streaming", isStreaming: false });
		expect(isStreaming).toBe(false);
	});

	it("emits a changed index that actually addresses the changed message", () => {
		const { effects, messages } = replay(name);
		const indices = effects.filter((e) => e.type === "message").map((e) => e.index);
		expect(indices.length).toBeGreaterThan(0);
		for (const index of indices) {
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(messages.length);
		}
	});

	it("stamps every assistant message with model identity", () => {
		const { messages } = replay(name);
		const assistants = messages.filter(isAssistant);
		expect(assistants.length).toBeGreaterThan(0);
		for (const message of assistants) {
			// Never assert the values -- model/provider are scrubbed in the
			// fixtures. Only that the required fields were populated.
			expect(typeof message.api).toBe("string");
			expect(typeof message.provider).toBe("string");
			expect(message.model.length).toBeGreaterThan(0);
			expect(message.usage.totalTokens).toBeGreaterThanOrEqual(0);
		}
	});

	it("never leaves a placeholder holding stale streamed text", () => {
		// After the turn, every agentMessage message must equal the
		// authoritative text from its `item/completed`, not the delta sum.
		const { messages } = replay(name);
		const finals = byMethod(readFixture(name), "item/completed")
			.map(itemOf)
			.filter((item): item is Extract<ThreadItem, { type: "agentMessage" }> => item.type === "agentMessage")
			.map((item) => item.text);
		const rendered = messages
			.filter(isAssistant)
			.flatMap((m) => m.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text);
		for (const text of finals) expect(rendered).toContain(text);
	});
});

describe("reasoning effort", () => {
	function turn(reducer: CodexReducer): AssistantTurn {
		reducer.handle(
			completedItem(
				{ type: "agentMessage", id: "a", text: "answered", phase: null, memoryCitation: null },
				10,
			),
		);
		const message = reducer.getState().messages.find(isAssistant);
		if (!message) throw new Error("no assistant message");
		return message;
	}

	it("stamps the effort the thread reported alongside the model", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		// Both `thread/start` and `thread/resume` answer with `reasoningEffort`;
		// the adapter hands either straight to `setIdentity`.
		reducer.setIdentity({ model: "m", modelProvider: "p", reasoningEffort: "high" });
		expect(turn(reducer).effort).toBe("high");
	});

	it("carries no effort field at all when the thread reports none", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.setIdentity({ model: "m", modelProvider: "p", reasoningEffort: null });
		const message = turn(reducer);
		expect(message.model).toBe("m");
		expect("effort" in message).toBe(false);
	});
});

describe("streaming assembly (text fixture)", () => {
	const lines = readFixture("text");
	const completed = byMethod(lines, "item/completed").map(itemOf);
	const finalText = itemOfType(completed, "agentMessage").text;
	const deltas = byMethod(lines, "item/agentMessage/delta").map((line) => line.params.delta);

	it("creates an empty placeholder on item/started", () => {
		const { messages } = replay("text", (line) => methodOf(line) === "item/agentMessage/delta");
		const last = messages.at(-1);
		expect(isAssistant(last)).toBe(true);
		expect(last && isAssistant(last) && last.content[0]).toEqual({ type: "text", text: "" });
	});

	it("appends deltas to the same message, correlated by itemId", () => {
		// Stop just before the authoritative item/completed for the agent message.
		let seenDelta = false;
		const { messages } = replay("text", (line) => {
			if (methodOf(line) === "item/agentMessage/delta") seenDelta = true;
			return seenDelta && methodOf(line) === "item/completed";
		});
		const streamed = messages.filter(isAssistant).at(-1);
		const text = streamed?.content[0];
		expect(text?.type).toBe("text");
		expect(text && text.type === "text" && text.text).toBe(deltas.join(""));
		// The placeholder is updated in place: user message + this one only.
		expect(messages.length).toBe(2);
	});

	it("replaces with the authoritative text on item/completed", () => {
		const { messages } = replay("text");
		const last = messages.at(-1);
		expect(isAssistant(last)).toBe(true);
		expect(last && isAssistant(last) && last.content).toEqual([{ type: "text", text: finalText }]);
		expect(deltas.join("")).toBe(finalText); // the capture agrees with itself
	});

	it("uses itemId for concurrent agent deltas and trusts completed content over the stream", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		for (const id of ["a1", "a2"]) {
			reducer.handle({
				method: "item/started",
				params: {
					threadId: "t",
					turnId: "u",
					item: { type: "agentMessage", id, text: "", phase: null, memoryCitation: null },
					startedAtMs: 1,
				},
			});
		}
		reducer.handle({
			method: "item/agentMessage/delta",
			params: { threadId: "t", turnId: "u", itemId: "a2", delta: "streamed draft" },
		});

		const streamed = reducer.getState().messages as AssistantMessage[];
		expect(streamed[0]?.content).toEqual([{ type: "text", text: "" }]);
		expect(streamed[1]?.content).toEqual([{ type: "text", text: "streamed draft" }]);

		reducer.handle({
			method: "item/completed",
			params: {
				threadId: "t",
				turnId: "u",
				item: {
					type: "agentMessage",
					id: "a2",
					text: "authoritative completion",
					phase: "final_answer",
					memoryCitation: null,
				},
				completedAtMs: 2,
			},
		});
		const completedMessages = reducer.getState().messages as AssistantMessage[];
		expect(completedMessages).toHaveLength(2);
		expect(completedMessages[1]?.content).toEqual([
			{ type: "text", text: "authoritative completion" },
		]);
	});

	it("suppresses hidden (empty) reasoning items rather than emitting blank thinking blocks", () => {
		const reasoning = byMethod(lines, "item/completed")
			.map(itemOf)
			.filter((item) => item.type === "reasoning");
		expect(reasoning.length).toBeGreaterThan(0); // the fixture does contain them
		const { messages } = replay("text");
		const thinking = messages
			.filter(isAssistant)
			.flatMap((m) => m.content)
			.filter((block) => block.type === "thinking");
		expect(thinking).toEqual([]);
	});

	it("carries the user prompt through as a user message", () => {
		const prompt = itemOfType(byMethod(lines, "item/completed").map(itemOf), "userMessage");
		const expected = prompt.content[0];
		const { messages } = replay("text");
		const user = messages[0] as UserMessage;
		expect(user.role).toBe("user");
		expect(expected?.type).toBe("text");
		if (expected?.type !== "text") throw new Error("fixture user input is not text");
		expect(user.content).toEqual([{ type: "text", text: expected.text }]);
	});
});

describe("item lifecycle regressions", () => {
	it("authoritative empty completion removes streamed reasoning without disturbing adjacent items", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.handle(
			startedItem(
				{
					type: "userMessage",
					id: "before",
					clientId: null,
					content: [{ type: "text", text: "before", text_elements: [] }],
				},
				10,
			),
		);
		reducer.handle(startedItem({ type: "reasoning", id: "reasoning", summary: [], content: [] }, 20));
		reducer.handle({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "reasoning",
				delta: "temporary reasoning",
				summaryIndex: 0,
			},
		});
		reducer.handle(
			startedItem(
				{ type: "agentMessage", id: "after", text: "after", phase: null, memoryCitation: null },
				30,
			),
		);

		const effects = reducer.handle(
			completedItem({ type: "reasoning", id: "reasoning", summary: [], content: [] }, 40),
		);

		expect(effects).toEqual([{ type: "reset" }]);
		expect(reducer.getState().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect((reducer.getState().messages[1] as AssistantMessage).content).toEqual([
			{ type: "text", text: "after" },
		]);
	});

	it("keeps the start timestamp through deltas and authoritative completion", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.handle(
			startedItem(
				{ type: "agentMessage", id: "a", text: "", phase: null, memoryCitation: null },
				100,
			),
		);
		const started = reducer.getState().messages[0]?.timestamp;
		reducer.handle({
			method: "item/agentMessage/delta",
			params: { threadId: "t", turnId: "u", itemId: "a", delta: "draft" },
		});
		const streamed = reducer.getState().messages[0]?.timestamp;
		reducer.handle(
			completedItem(
				{
					type: "agentMessage",
					id: "a",
					text: "final",
					phase: "final_answer",
					memoryCitation: null,
				},
				900,
			),
		);
		const completed = reducer.getState().messages[0]?.timestamp;

		expect([started, streamed, completed]).toEqual([100, 100, 100]);
	});

	it("inserts reasoning at its original item position when it becomes visible late", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.handle(startedItem({ type: "reasoning", id: "first", summary: [], content: [] }, 10));
		reducer.handle(
			startedItem(
				{ type: "agentMessage", id: "second", text: "later", phase: null, memoryCitation: null },
				20,
			),
		);

		const effects = reducer.handle({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "first",
				delta: "earlier",
				summaryIndex: 0,
			},
		});

		expect(effects).toEqual([{ type: "reset" }]);
		const messages = reducer.getState().messages as AssistantMessage[];
		expect(messages.map((message) => message.content[0]?.type)).toEqual(["thinking", "text"]);
		expect(messages[0]?.content).toEqual([{ type: "thinking", thinking: "earlier" }]);
		expect(messages[1]?.content).toEqual([{ type: "text", text: "later" }]);
	});

	it.each([
		{
			name: "agent message",
			started: startedItem(
				{ type: "agentMessage", id: "agent", text: "", phase: null, memoryCitation: null },
				10,
			),
			delta: {
				method: "item/agentMessage/delta",
				params: { threadId: "t", turnId: "u", itemId: "agent", delta: "live" },
			} satisfies CodexServerMessage,
			completed: completedItem(
				{ type: "agentMessage", id: "agent", text: "done", phase: null, memoryCitation: null },
				20,
			),
		},
		{
			name: "reasoning",
			started: startedItem({ type: "reasoning", id: "reasoning", summary: [], content: [] }, 10),
			delta: {
				method: "item/reasoning/summaryTextDelta",
				params: {
					threadId: "t",
					turnId: "u",
					itemId: "reasoning",
					delta: "live",
					summaryIndex: 0,
				},
			} satisfies CodexServerMessage,
			completed: completedItem(
				{ type: "reasoning", id: "reasoning", summary: ["done"], content: [] },
				20,
			),
		},
		{
			name: "plan",
			started: startedItem({ type: "plan", id: "plan", text: "" }, 10),
			delta: {
				method: "item/plan/delta",
				params: { threadId: "t", turnId: "u", itemId: "plan", delta: "live" },
			} satisfies CodexServerMessage,
			completed: completedItem({ type: "plan", id: "plan", text: "done" }, 20),
		},
	])("keeps a streaming $name pending until completion", ({ started, delta, completed }) => {
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.handle(started);
		const startedMessage = reducer.getState().messages.at(-1);
		if (started.params.item.type !== "reasoning") {
			expect(startedMessage?.role).toBe("assistant");
			expect((startedMessage as AssistantMessage).stopReason).toBe("pending");
		}

		reducer.handle(delta);
		const streamedMessage = reducer.getState().messages.at(-1) as AssistantMessage;
		expect(streamedMessage.stopReason).toBe("pending");

		reducer.handle(completed);
		const completedMessage = reducer.getState().messages.at(-1) as AssistantMessage;
		expect(completedMessage.stopReason).toBe("stop");
	});

	it.each([
		{ fixture: "tool-read" as const, type: "commandExecution" as const },
		{ fixture: "tool-edit" as const, type: "fileChange" as const },
	])("withholds the $type result until authoritative completion", ({ fixture, type }) => {
		const lines = readFixture(fixture);
		const started = byMethod(lines, "item/started").find((line) => itemOf(line).type === type);
		if (!started) throw new Error(`${fixture} has no started ${type}`);
		const itemId = itemOf(started).id;
		const completed = byMethod(lines, "item/completed").find((line) => itemOf(line).id === itemId);
		if (!completed) throw new Error(`${fixture} has no completed ${type}`);

		const reducer = new CodexReducer({ now: () => 1 });
		reducer.handle(started);
		const pending = reducer.getState().messages;
		expect(pending.map((message) => message.role)).toEqual(["assistant"]);
		expect((pending[0] as AssistantMessage).stopReason).toBe("pending");

		reducer.handle(completed);
		const done = reducer.getState().messages;
		expect(done.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
		expect((done[0] as AssistantMessage).stopReason).toBe("toolUse");
		const result = done[1] as ToolResultMessage;
		expect(result.toolCallId).toBe(itemId);
	});
});

describe("commandExecution (tool-read fixture)", () => {
	const lines = readFixture("tool-read");
	const item = itemOfType(byMethod(lines, "item/completed").map(itemOf), "commandExecution");

	it("becomes a toolCall/toolResult pair correlated by item id", () => {
		const { messages } = replay("tool-read");
		const callIndex = messages.findIndex(
			(m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall"),
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		const call = messages[callIndex] as AssistantMessage;
		const block = call.content[0];
		expect(block?.type).toBe("toolCall");
		if (block?.type !== "toolCall") throw new Error("unreachable");
		expect(block.id).toBe(item.id);
		expect(block.name).toBe(CODEX_TOOL_NAMES.commandExecution);
		expect(block.arguments["command"]).toBe(item.command);
		expect(call.stopReason).toBe("toolUse");

		const result = messages[callIndex + 1] as ToolResultMessage;
		expect(result.role).toBe("toolResult");
		expect(result.toolCallId).toBe(item.id);
		expect(result.toolName).toBe(CODEX_TOOL_NAMES.commandExecution);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: item.aggregatedOutput }]);
		expect((result.details as { exitCode: number }).exitCode).toBe(item.exitCode);
	});

	it("does not expose streamed command output as a result before completion", () => {
		const reducer = new CodexReducer({ now: () => 1 });
		const started = byMethod(lines, "item/started").find(
			(line) => itemOf(line).type === "commandExecution",
		);
		if (!started) throw new Error("fixture has no started commandExecution");
		reducer.handle(started);
		const id = itemOf(started).id;
		for (const chunk of ["one\n", "two\n"]) {
			reducer.handle({
				method: "item/commandExecution/outputDelta",
				params: { threadId: "t", turnId: "u", itemId: id, delta: chunk },
			});
		}
		expect(reducer.getState().messages.map((message) => message.role)).toEqual(["assistant"]);

		const completed = byMethod(lines, "item/completed").find((line) => itemOf(line).id === id);
		if (!completed) throw new Error("fixture has no completed commandExecution");
		reducer.handle(completed);
		const result = reducer.getState().messages.at(-1) as ToolResultMessage;
		expect(result.role).toBe("toolResult");
		expect(result.content).toEqual([{ type: "text", text: item.aggregatedOutput }]);
	});
});

describe("fileChange and approvals (tool-edit fixture)", () => {
	const lines = readFixture("tool-edit");
	const item = itemOfType(byMethod(lines, "item/completed").map(itemOf), "fileChange");

	it("becomes an edit pair whose arguments satisfy the renderer contract", () => {
		const { messages } = replay("tool-edit");
		const callIndex = messages.findIndex(
			(m) =>
				m.role === "assistant" &&
				m.content.some((b) => b.type === "toolCall" && b.name === CODEX_TOOL_NAMES.fileChange),
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		const call = messages[callIndex] as AssistantMessage;
		const block = call.content.find((content) => content.type === "toolCall");
		expect(block?.type).toBe("toolCall");
		if (block?.type !== "toolCall") throw new Error("file change has no tool call");
		expect(block.name).toBe("edit");
		expect(block.arguments["path"]).toBe(item.changes[0]?.path);

		const edits = block.arguments["edits"];
		expect(Array.isArray(edits)).toBe(true);
		if (!Array.isArray(edits)) throw new Error("edit arguments have no edits array");
		expect(edits.length).toBeGreaterThan(0);
		for (const edit of edits) {
			expect(isRecord(edit)).toBe(true);
			if (!isRecord(edit)) throw new Error("edit hunk is not an object");
			expect(typeof edit["oldText"]).toBe("string");
			expect(typeof edit["newText"]).toBe("string");
		}
		expect(edits.some((edit) => isRecord(edit) && edit["oldText"] !== edit["newText"])).toBe(true);

		const result = messages[callIndex + 1] as ToolResultMessage;
		expect(result.role).toBe("toolResult");
		expect(result.toolCallId).toBe(item.id);
		expect(result.isError).toBe(false);
		const text = result.content[0];
		expect(text?.type).toBe("text");
		expect(text && text.type === "text" && text.text).toContain(item.changes[0]?.diff);
		expect((result.details as { changes: unknown[] }).changes).toHaveLength(item.changes.length);
	});

	it("surfaces the blocking approval ServerRequest, then its resolution", () => {
		const { effects } = replay("tool-edit");
		const request = effects.find((e) => e.type === "request");
		expect(request).toBeDefined();
		if (request?.type !== "request") throw new Error("unreachable");
		expect(request.kind).toBe("item/fileChange/requestApproval");
		// The recorded request carries the id Codex chose (a number here).
		const recorded = byMethod(lines, "item/fileChange/requestApproval")[0];
		expect(recorded).toBeDefined();
		if (!recorded) throw new Error("fixture has no file-change approval request");
		expect(request.requestId).toBe(recorded.id);
		expect(request.payload).toEqual(recorded.params);
		expect(recorded.params.itemId).toBe(item.id);

		const resolved = effects.find((e) => e.type === "request-resolved");
		expect(resolved).toBeDefined();
		expect(effects.indexOf(request)).toBeLessThan(effects.indexOf(resolved as CodexEffect));
	});

	it("keeps the cumulative turn diff and the token usage", () => {
		const { reducer, messages } = replay("tool-edit");
		const lastDiff = byMethod(lines, "turn/diff/updated").at(-1);
		expect(lastDiff).toBeDefined();
		expect(reducer.turnDiff).toBe(lastDiff?.params.diff);
		expect(reducer.tokenUsage?.total.totalTokens).toBeGreaterThan(0);
		// `last` usage lands on an assistant message so a cost display can read it.
		expect(messages.filter(isAssistant).some((m) => m.usage.totalTokens > 0)).toBe(true);
	});

	it("does not rebuild the transcript from turn/completed's summary view", () => {
		// turn/completed carries `itemsView: "summary"` -- only the final agent
		// message. Treating it as the turn's items would delete the turn.
		const { messages } = replay("tool-edit");
		expect(messages.length).toBe(expectedMessageCount("tool-edit"));
		expect(messages.length).toBeGreaterThan(2);
	});
});

describe("defensive handling", () => {
	const reducer = () => new CodexReducer({ now: () => 1 });

	it("ignores an unknown item type instead of throwing", () => {
		const r = reducer();
		const effects = r.handle(unsafeMessage({
			method: "item/started",
			params: {
				item: { type: "quantumEntanglement", id: "x1", nonsense: true },
				threadId: "t",
				turnId: "u",
				startedAtMs: 5,
			},
		}));
		expect(effects).toEqual([]);
		expect(r.getState().messages).toEqual([]);
		expect(r.unmappedItemTypes.has("quantumEntanglement")).toBe(true);
	});

	it.each([
		"collabAgentToolCall",
		"subAgentActivity",
		"hookPrompt",
		"contextCompaction",
		"enteredReviewMode",
	])("does not crash on the uncaptured item type %s", (type) => {
		const r = reducer();
		expect(() =>
			r.handle(
				unsafeMessage({
					method: "item/completed",
					params: { item: { type, id: "i" }, completedAtMs: 1 },
				}),
			),
		).not.toThrow();
		expect(r.getState().messages).toEqual([]);
	});

	it("ignores a delta for an item it never saw start", () => {
		const r = reducer();
		expect(
			r.handle({
				method: "item/agentMessage/delta",
				params: { threadId: "t", turnId: "u", itemId: "ghost", delta: "hi" },
			}),
		).toEqual([]);
		expect(r.getState().messages).toEqual([]);
	});

	it("ignores malformed envelopes that do not claim a generated method", () => {
		const r = reducer();
		expect(r.handle(unsafeMessage({}))).toEqual([]);
		expect(r.handle(unsafeMessage(null))).toEqual([]);
	});

	it("reports a failed turn as an error effect", () => {
		const r = reducer();
		const effects = r.handle({
			method: "turn/completed",
			params: {
				threadId: "t",
				turn: {
					id: "u",
					items: [],
					itemsView: "full",
					status: "failed",
					error: { message: "model exploded", codexErrorInfo: null, additionalDetails: null },
					startedAt: 1,
					completedAt: 2,
					durationMs: 1_000,
				},
			},
		});
		expect(effects).toContainEqual({ type: "error", message: "model exploded" });
	});

	it("reports the error notification", () => {
		const r = reducer();
		expect(
			r.handle({
				method: "error",
				params: {
					error: { message: "stream reset", codexErrorInfo: null, additionalDetails: null },
					willRetry: false,
					threadId: "t",
					turnId: "u",
				},
			}),
		).toEqual([{ type: "error", message: "stream reset" }]);
	});
});

describe("item types with no fixture yet", () => {
	// The fixtures cover userMessage/reasoning/agentMessage/commandExecution/
	// fileChange only. These rows are exercised against hand-built items taken
	// from the generated bindings, so they at least cannot regress silently.
	const reducer = () => new CodexReducer({ now: () => 7 });

	function complete(item: ThreadItem) {
		const r = reducer();
		r.handle({
			method: "item/completed",
			params: { threadId: "t", turnId: "u", item, completedAtMs: 7 },
		});
		return r.getState().messages;
	}

	it("maps mcpToolCall to a namespaced tool pair", () => {
		const messages = complete({
			type: "mcpToolCall",
			id: "m1",
			server: "docs",
			tool: "search",
			status: "completed",
			arguments: { q: "svelte" },
			appContext: null,
			pluginId: null,
			readOnlyHint: true,
			result: { content: [{ type: "text", text: "a result" }], structuredContent: null, _meta: null },
			error: null,
			durationMs: 12,
		});
		const call = messages[0] as AssistantMessage;
		const block = call.content[0];
		expect(block?.type === "toolCall" && block.name).toBe("docs__search");
		expect(block?.type === "toolCall" && block.arguments).toEqual({ q: "svelte" });
		const result = messages[1] as ToolResultMessage;
		expect(result.content).toEqual([{ type: "text", text: "a result" }]);
		expect(result.isError).toBe(false);
	});

	it("marks an mcpToolCall error as an error result", () => {
		const messages = complete({
			type: "mcpToolCall",
			id: "m2",
			server: "docs",
			tool: "search",
			status: "failed",
			arguments: {},
			appContext: null,
			pluginId: null,
			readOnlyHint: null,
			result: null,
			error: { message: "server unreachable" },
			durationMs: null,
		});
		const result = messages[1] as ToolResultMessage;
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "server unreachable" }]);
	});

	it("maps dynamicToolCall, whose name cannot be pre-registered", () => {
		const messages = complete({
			type: "dynamicToolCall",
			id: "d1",
			namespace: "app",
			tool: "doThing",
			arguments: { a: 1 },
			status: "completed",
			contentItems: [{ type: "inputText", text: "done" }],
			success: true,
			durationMs: 3,
		});
		const block = (messages[0] as AssistantMessage).content[0];
		expect(block?.type === "toolCall" && block.name).toBe("app__doThing");
		expect((messages[1] as ToolResultMessage).content).toEqual([{ type: "text", text: "done" }]);
	});

	it("maps webSearch to a tool pair", () => {
		const messages = complete({
			type: "webSearch",
			id: "w1",
			query: "svelte 5 runes",
			action: null,
			results: [{ title: "t", url: "u" }],
		});
		const block = (messages[0] as AssistantMessage).content[0];
		expect(block?.type === "toolCall" && block.name).toBe(CODEX_TOOL_NAMES.webSearch);
		expect(block?.type === "toolCall" && block.arguments["query"]).toBe("svelte 5 runes");
		expect((messages[1] as ToolResultMessage).isError).toBe(false);
	});

	it("maps plan to assistant text and streams its deltas", () => {
		const r = reducer();
		r.handle({
			method: "item/started",
			params: {
				threadId: "t",
				turnId: "u",
				item: { type: "plan", id: "p1", text: "" },
				startedAtMs: 7,
			},
		});
		r.handle({
			method: "item/plan/delta",
			params: { threadId: "t", turnId: "u", itemId: "p1", delta: "step 1" },
		});
		const message = r.getState().messages[0] as AssistantMessage;
		expect(message.content).toEqual([{ type: "text", text: "step 1" }]);
	});

	it("renders visible reasoning as a thinking block, streamed by summary index", () => {
		const r = reducer();
		for (const id of ["r1", "r2"]) {
			r.handle({
				method: "item/started",
				params: {
					threadId: "t",
					turnId: "u",
					item: { type: "reasoning", id, summary: [], content: [] },
					startedAtMs: 7,
				},
			});
		}
		expect(r.getState().messages).toEqual([]); // nothing yet -- no text
		r.handle({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "r1",
				delta: "weighing options",
				summaryIndex: 0,
			},
		});
		r.handle({
			method: "item/reasoning/textDelta",
			params: {
				threadId: "t",
				turnId: "u",
				itemId: "r1",
				delta: "raw chain",
				contentIndex: 0,
			},
		});
		const message = r.getState().messages[0] as AssistantMessage;
		expect(message.content).toEqual([{ type: "thinking", thinking: "weighing options\n\nraw chain" }]);
		expect(r.getState().messages).toHaveLength(1); // r2 stayed empty
	});

	it("drops contextCompaction, which carries no payload to render", () => {
		// Codex's contextCompaction item is `{type, id}` and nothing else, and
		// the compaction message type Pi has (`CompactionSummaryMessage`) is
		// declared in pi-coding-agent, which is not a dependency here. See the
		// workstream report.
		expect(complete({ type: "contextCompaction", id: "c1" })).toEqual([]);
	});
});

describe("hydrate (cold start)", () => {
	it("replays a thread/read response into a transcript", () => {
		const r = new CodexReducer({ now: () => 1 });
		const effects = r.hydrate({
			id: "thread-1",
			turns: [
				{
					id: "turn-1",
					items: [
						{ type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "hi", text_elements: [] }] },
						{ type: "agentMessage", id: "a1", text: "hello", phase: "final_answer", memoryCitation: null },
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1_700_000_000,
					completedAt: 1_700_000_001,
					durationMs: 1000,
				},
			],
		});
		expect(effects).toEqual([{ type: "reset" }]);
		const { messages } = r.getState();
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(messages[0]?.timestamp).toBe(1_700_000_000_000);
	});
});
