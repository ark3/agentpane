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
import { CODEX_TOOL_NAMES, mapItem } from "./mapping.ts";
import { CodexReducer, type CodexEffect } from "./reducer.ts";
import {
	isRecord,
	type CodexNotification,
	type CodexServerMessage,
	type ThreadItem,
	type UserInput,
} from "./protocol.ts";
import {
	byMethod,
	itemOf,
	readFixture,
	readFixtureMeta,
	type FixtureName,
} from "./test-support.ts";

const FIXTURES = ["text", "tool-read", "tool-edit"] as const satisfies readonly FixtureName[];

const EXPECTED_ROLES: Record<Exclude<FixtureName, "compact" | "subagent">, AgentMessage["role"][]> = {
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

describe("replaying the subagent fixture", () => {
	it("keeps child-thread notifications out of the parent transcript", () => {
		const lines = readFixture("subagent");
		const parentThreadId = readFixtureMeta("subagent").thread_id;
		if (!parentThreadId) throw new Error("subagent fixture has no parent thread id");
		const childStarted = byMethod(lines, "turn/started").find(
			(line) => line.params.threadId !== parentThreadId,
		);
		if (!childStarted) throw new Error("subagent fixture has no child turn");
		const childThreadId = childStarted.params.threadId;
		const parentThreadStarted = byMethod(lines, "thread/started")[0];
		if (!parentThreadStarted) throw new Error("subagent fixture has no parent thread/started");

		const reducer = new CodexReducer({ now: () => 1_000 });
		let injectedChildStart = false;
		for (const line of lines) {
			if (!injectedChildStart && "method" in line && "threadId" in line.params && line.params.threadId === childThreadId) {
				const childThreadStarted = structuredClone(parentThreadStarted);
				childThreadStarted.params.thread.id = childThreadId;
				reducer.handle(childThreadStarted);
				injectedChildStart = true;
			}
			reducer.handle(line);
		}

		expect(injectedChildStart).toBe(true);
		expect(reducer.threadId).toBe(parentThreadId);
		// Every parent item that renders, and nothing from the child: the
		// collab items are the parent's own view of the subagent (OW-benige),
		// so they belong here; the child's userMessage and agentMessage do not.
		const parentMessageRoles = byMethod(lines, "item/completed")
			.filter((line) => line.params.threadId === parentThreadId)
			.map(itemOf)
			.flatMap((item): AgentMessage["role"][] => {
				if (item.type === "userMessage") return ["user"];
				if (item.type === "agentMessage") return ["assistant"];
				if (item.type === "collabAgentToolCall") return ["assistant", "toolResult"];
				return [];
			});
		expect(reducer.getState().messages.map((message) => message.role)).toEqual(parentMessageRoles);
	});

	it("renders each collab item as a tool pair naming the child thread", () => {
		const lines = readFixture("subagent");
		const parentThreadId = readFixtureMeta("subagent").thread_id;
		const collabItems = byMethod(lines, "item/completed")
			.filter((line) => line.params.threadId === parentThreadId)
			.map(itemOf)
			.filter((item) => item.type === "collabAgentToolCall");
		// The capture exercises spawnAgent then wait, in that order.
		expect(collabItems.map((item) => item.tool)).toEqual(["spawnAgent", "wait"]);

		const { messages } = replay("subagent");
		const calls = messages
			.filter(isAssistant)
			.flatMap((message) => message.content)
			.filter((block) => block.type === "toolCall")
			.filter((block) => block.name === CODEX_TOOL_NAMES.collabAgentToolCall);
		expect(calls.map((call) => call.id)).toEqual(collabItems.map((item) => item.id));
		expect(calls.map((call) => call.arguments["tool"])).toEqual(collabItems.map((item) => item.tool));

		const spawn = collabItems[0];
		const wait = collabItems[1];
		if (!spawn || !wait) throw new Error("subagent fixture lost its collab items");
		const childThreadId = spawn.receiverThreadIds[0];
		if (!childThreadId) throw new Error("spawn completion carries no child thread id");
		expect(calls[0]?.arguments["prompt"]).toBe(spawn.prompt);
		expect(calls[0]?.arguments["threadIds"]).toEqual([childThreadId]);
		expect(calls[1]?.arguments["threadIds"]).toEqual([childThreadId]);

		const results = messages.filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === CODEX_TOOL_NAMES.collabAgentToolCall,
		);
		expect(results.map((r) => r.toolCallId)).toEqual(collabItems.map((item) => item.id));
		expect(results.every((r) => r.isError === false)).toBe(true);

		// The wait completion carries the child's final message, so the parent
		// transcript shows what the subagent answered without reading the child
		// thread at all.
		const childMessage = wait.agentsStates[childThreadId]?.message;
		expect(childMessage).toBeTruthy();
		expect(results[1]?.content).toEqual([{ type: "text", text: childMessage }]);
	});
});

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

describe("replaying the compact fixture", () => {
	it("enters running once and clears it in the update that appends the marker", () => {
		const reducer = new CodexReducer({ now: () => 1_000 });
		const transitions: { compaction: string | null; effects: CodexEffect[] }[] = [];
		let previous = reducer.getState().compaction;
		for (const line of readFixture("compact")) {
			const effects = reducer.handle(line);
			const current = reducer.getState().compaction;
			if (current !== previous) transitions.push({ compaction: current, effects });
			previous = current;
		}
		expect(transitions.map(({ compaction }) => compaction)).toEqual(["running", null]);
		expect(transitions[1]?.effects).toContainEqual({ type: "message", index: expect.any(Number) });
		expect(reducer.getState().messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
	});

	it("carries the pre-compaction token figure onto the marker (OW-kelomi)", () => {
		// The figure has to be the one live *before* the compaction, because the
		// same name means the same thing on Pi's marker. `thread/tokenUsage/
		// updated` fires three more times between `item/started` and
		// `item/completed` (`last.totalTokens` 16304 -> 14692 -> 4844), so the
		// value sitting in the reducer when the completed item is mapped is the
		// *post*-compaction one. Asserted as the exact number: "greater than
		// zero" would pass on 4844, which is the bug this guards.
		const reducer = new CodexReducer({ now: () => 1_000 });
		for (const line of readFixture("compact")) reducer.handle(line);
		const marker = reducer.getState().messages.find((message) => message.role === "compactionSummary");
		expect(marker).toMatchObject({ role: "compactionSummary", summary: "", tokensBefore: 16_304 });
	});

	it("clears a running compaction when its turn is interrupted before item completion", () => {
		const reducer = new CodexReducer({ now: () => 1_000 });
		reducer.handle(startedItem({ type: "contextCompaction", id: "compact" }, 10));
		expect(reducer.getState().compaction).toBe("running");

		const effects = reducer.handle({
			method: "turn/completed",
			params: {
				threadId: "t",
				turn: {
					id: "u",
					items: [],
					itemsView: "summary",
					status: "interrupted",
					error: null,
					startedAt: 1,
					completedAt: 2,
					durationMs: 1_000,
				},
			},
		});

		expect(reducer.getState().compaction).toBeNull();
		expect(effects).toContainEqual({ type: "compaction", compaction: null });
	});
});

describe("reasoning effort", () => {
	function turn(reducer: CodexReducer): AssistantTurn {
		reducer.handle(
			completedItem(
				{ type: "agentMessage", id: "a", text: "answered", phase: null, memoryCitation: null, delivery: null, questions: null },
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
					item: { type: "agentMessage", id, text: "", phase: null, memoryCitation: null, delivery: null, questions: null },
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
					delivery: null,
					questions: null,
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
				{ type: "agentMessage", id: "after", text: "after", phase: null, memoryCitation: null, delivery: null, questions: null },
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
				{ type: "agentMessage", id: "a", text: "", phase: null, memoryCitation: null, delivery: null, questions: null },
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
					delivery: null,
					questions: null,
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
				{ type: "agentMessage", id: "second", text: "later", phase: null, memoryCitation: null, delivery: null, questions: null },
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
				{ type: "agentMessage", id: "agent", text: "", phase: null, memoryCitation: null, delivery: null, questions: null },
				10,
			),
			delta: {
				method: "item/agentMessage/delta",
				params: { threadId: "t", turnId: "u", itemId: "agent", delta: "live" },
			} satisfies CodexServerMessage,
			completed: completedItem(
				{ type: "agentMessage", id: "agent", text: "done", phase: null, memoryCitation: null, delivery: null, questions: null },
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

	it("does not report a hidden reasoning item's type as unmapped", () => {
		// Every fixture's reasoning items arrive with empty summary and content,
		// which maps to `kind: "none"` by design. Collecting those alongside a
		// type Codex invented since we last looked would make an unknown type
		// invisible in the ordinary case.
		const { reducer } = replay("text");
		const reasoning = byMethod(readFixture("text"), "item/completed")
			.map(itemOf)
			.filter((item) => item.type === "reasoning");
		expect(reasoning.length).toBeGreaterThan(0);
		expect(reducer.unmappedItemTypes.has("reasoning")).toBe(false);
	});

	it.each([
		"subAgentActivity",
		"hookPrompt",
		"enteredReviewMode",
	])("does not crash on the silently ignored item type %s", (type) => {
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

	it("opens an item it never saw start from its first text delta (OW-zudase)", () => {
		const r = reducer();
		expect(
			r.handle({
				method: "item/agentMessage/delta",
				params: { threadId: "t", turnId: "u", itemId: "before-attach", delta: "hi" },
			}),
		).toEqual([{ type: "message", index: 0 }]);
		expect(r.getState().messages).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "pending" },
		]);
	});

	it("ignores command output for an item it never saw start", () => {
		const r = reducer();
		expect(
			r.handle({
				method: "item/commandExecution/outputDelta",
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
					error: { message: "model exploded", codexErrorInfo: null, additionalDetails: null, misalignment: null },
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
					error: { message: "stream reset", codexErrorInfo: null, additionalDetails: null, misalignment: null },
					willRetry: false,
					threadId: "t",
					turnId: "u",
				},
			}),
		).toEqual([{ type: "error", message: "stream reset" }]);
	});

	// The shape `codex-cli 0.156.0` delivered for a turn the upstream API refused
	// (docs/MANUAL_TESTING.md, OW-wawuzu): an `error` notification, then a failed
	// `turn/completed`, both carrying the upstream response serialized as a string.
	const upstream = (message: string) =>
		JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message } });

	function errorNotification(turnId: string, message: string, willRetry = false): CodexServerMessage {
		return {
			method: "error",
			params: {
				error: { message, codexErrorInfo: "other", additionalDetails: null, misalignment: null },
				willRetry,
				threadId: "t",
				turnId,
			},
		};
	}

	function failedTurn(turnId: string, message: string): CodexServerMessage {
		return {
			method: "turn/completed",
			params: {
				threadId: "t",
				turn: {
					id: turnId,
					items: [],
					itemsView: "summary",
					status: "failed",
					error: { message, codexErrorInfo: "other", additionalDetails: null, misalignment: null },
					startedAt: 1,
					completedAt: 2,
					durationMs: 1_618,
				},
			},
		};
	}

	const errorsOf = (effects: CodexEffect[]) => effects.filter((effect) => effect.type === "error");

	it("reports an upstream refusal once, as the inner message", () => {
		const r = reducer();
		const raw = upstream("the model is not supported");
		const effects = [...r.handle(errorNotification("u", raw)), ...r.handle(failedTurn("u", raw))];
		expect(errorsOf(effects)).toEqual([{ type: "error", message: "the model is not supported" }]);
	});

	it("unwraps an upstream refusal that only a failed turn reports", () => {
		const r = reducer();
		expect(errorsOf(r.handle(failedTurn("u", upstream("refused"))))).toEqual([
			{ type: "error", message: "refused" },
		]);
	});

	it("does not report an error Codex is still retrying", () => {
		const r = reducer();
		r.requestCompaction();
		// Nothing at all: the turn is still live, so a pending compaction stays too.
		expect(r.handle(errorNotification("u", "stream reset", true))).toEqual([]);
		expect(r.getState().compaction).toBe("requesting");
		// Retries ran out: the failed turn is the only report, so it must not be suppressed.
		expect(errorsOf(r.handle(failedTurn("u", "stream reset")))).toEqual([
			{ type: "error", message: "stream reset" },
		]);
	});

	it("still reports a later turn's failure after deduplicating an earlier one", () => {
		const r = reducer();
		r.handle(errorNotification("u1", "first"));
		r.handle(failedTurn("u1", "first"));
		expect(errorsOf(r.handle(failedTurn("u2", "second")))).toEqual([{ type: "error", message: "second" }]);
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
			mcpAppUi: null,
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
			mcpAppUi: null,
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

	describe("functionCallOutput (OW-vevizo)", () => {
		// The two shapes `codex-cli 0.156.0` sent for a `turn/start` carrying
		// `toolOutput` (docs/MANUAL_TESTING.md, OW-vevizo): `item/started` and
		// `item/completed` with the same whole item, no call in front of it.
		function drive(item: ThreadItem) {
			const r = reducer();
			r.handle({ method: "item/started", params: { threadId: "t", turnId: "u", item, startedAtMs: 7 } });
			r.handle({ method: "item/completed", params: { threadId: "t", turnId: "u", item, completedAtMs: 7 } });
			return r;
		}

		it("draws a string output as a tool result named for the bare tool", () => {
			const r = drive({ type: "functionCallOutput", id: "fco_1", name: "probe_tool", namespace: null, output: "the output" });
			expect(r.unmappedItemTypes.has("functionCallOutput")).toBe(false);
			const [call, result] = r.getState().messages as [AssistantMessage, ToolResultMessage];
			expect(call.content).toEqual([{ type: "toolCall", id: "fco_1", name: "probe_tool", arguments: {} }]);
			expect(result).toMatchObject({ role: "toolResult", toolCallId: "fco_1", toolName: "probe_tool", isError: false });
			expect(result.content).toEqual([{ type: "text", text: "the output" }]);
		});

		it("draws a content-item list's text and image under a namespaced name", () => {
			const r = drive({
				type: "functionCallOutput",
				id: "fco_2",
				name: "probe_tool",
				namespace: "probe_ns",
				output: [
					{ type: "input_text", text: "the output" },
					{ type: "input_image", image_url: "data:image/png;base64,QUJD" },
				],
			});
			expect(r.unmappedItemTypes.has("functionCallOutput")).toBe(false);
			const [call, result] = r.getState().messages as [AssistantMessage, ToolResultMessage];
			const block = call.content[0];
			expect(block?.type === "toolCall" && block.name).toBe("probe_ns__probe_tool");
			expect(result.toolName).toBe("probe_ns__probe_tool");
			expect(result.content).toEqual([
				{ type: "text", text: "the output" },
				{ type: "image", data: "QUJD", mimeType: "image/png" },
			]);
		});

		it("degrades the parts it cannot draw to plain references", () => {
			// Built from the generated type; no run sent these parts.
			const r = drive({
				type: "functionCallOutput",
				id: "fco_3",
				name: "probe_tool",
				namespace: null,
				output: [
					{ type: "input_image", file_id: "file-1" },
					{ type: "input_audio", audio_url: "https://example.com/a.wav" },
					{ type: "encrypted_content", encrypted_content: "gAAAA" },
				],
			});
			expect((r.getState().messages[1] as ToolResultMessage).content).toEqual([
				{ type: "text", text: "[image: file-1]" },
				{ type: "text", text: "[audio: https://example.com/a.wav]" },
				{ type: "text", text: "[encrypted content]" },
			]);
		});
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

	it("maps imageGeneration's result through the image reference", () => {
		// An assistant turn carries no image block, so an inline data URL is
		// degraded to its mime type and a plain result stays a reference.
		const inline = complete({
			type: "imageGeneration",
			id: "g1",
			status: "completed",
			revisedPrompt: null,
			failure: null,
			result: "data:image/png;base64,QUJD",
		});
		expect((inline[0] as AssistantMessage).content).toEqual([
			{ type: "text", text: "[image: image/png]" },
		]);
		const referenced = complete({
			type: "imageGeneration",
			id: "g2",
			status: "completed",
			revisedPrompt: null,
			failure: null,
			result: "/tmp/generated.png",
		});
		expect((referenced[0] as AssistantMessage).content).toEqual([
			{ type: "text", text: "[image: /tmp/generated.png]" },
		]);
	});

	it("maps imageView to a path reference", () => {
		const messages = complete({ type: "imageView", id: "v1", path: "/tmp/screenshot.png" });
		expect((messages[0] as AssistantMessage).content).toEqual([
			{ type: "text", text: "[image: /tmp/screenshot.png]" },
		]);
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

	it("renders contextCompaction as a bare marker: no summary text, no token figure", () => {
		// OW-72: the item is `{ type, id }` and nothing else, so the marker is
		// empty-bodied -- a `compactionSummary` message with an empty summary.
		// `Message.svelte` draws the marker regardless, and the transcript can no
		// longer silently drop the compaction. The old behaviour was `toEqual([])`;
		// this went red against that first.
		//
		// `tokensBefore` is 0 here and that is the honest answer, not a leftover:
		// this helper sends only `item/completed`, so no `thread/tokenUsage/
		// updated` and no `item/started` were ever seen and there is no
		// pre-compaction figure to report (OW-kelomi). The same holds for a cold
		// hydrate. The fixture-driven case above is where the figure is asserted.
		const messages = complete({ type: "contextCompaction", id: "c1" });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "compactionSummary", summary: "", tokensBefore: 0 });
	});

	// Every fixture carries `{"type":"text"}` user input and nothing else. The
	// other variants degrade to a text stand-in that is the only thing a user
	// sees for that input, and `userInputToContent`'s switch has no `default`:
	// an arm dropped into the fall-through would contribute nothing at all
	// rather than degrade visibly, and no assertion elsewhere would notice. So
	// the stand-in text is asserted exactly -- here the string *is* the
	// behaviour, and it is our wording, not the model's.
	describe("user input variants no fixture carries", () => {
		function userContent(input: UserInput) {
			const messages = complete({
				type: "userMessage",
				id: "u1",
				clientId: null,
				content: [input],
			});
			return (messages[0] as UserMessage).content;
		}

		it("degrades localImage to a path reference", () => {
			expect(userContent({ type: "localImage", path: "/tmp/shot.png" })).toEqual([
				{ type: "text", text: "[image: /tmp/shot.png]" },
			]);
		});

		it("degrades an image given by fileId to a file reference", () => {
			expect(userContent({ type: "image", fileId: "file-abc" })).toEqual([
				{ type: "text", text: "[image: file-abc]" },
			]);
		});

		it("degrades audio to a url reference", () => {
			expect(userContent({ type: "audio", url: "https://example.test/clip.wav" })).toEqual([
				{ type: "text", text: "[audio: https://example.test/clip.wav]" },
			]);
		});

		it("degrades localAudio to a path reference", () => {
			expect(userContent({ type: "localAudio", path: "/tmp/clip.wav" })).toEqual([
				{ type: "text", text: "[audio: /tmp/clip.wav]" },
			]);
		});

		it("names a skill, not the path it was loaded from", () => {
			expect(userContent({ type: "skill", name: "brainstorm", path: "/skills/brainstorm" })).toEqual(
				[{ type: "text", text: "[skill: brainstorm]" }],
			);
		});

		it("re-spells a mention as the @name the user typed", () => {
			expect(userContent({ type: "mention", name: "AGENTS.md", path: "/repo/AGENTS.md" })).toEqual([
				{ type: "text", text: "@AGENTS.md" },
			]);
		});
	});
});

describe("hydrate (cold start)", () => {
	it("replays a thread's turns into a transcript", () => {
		const r = new CodexReducer({ now: () => 1 });
		const effects = r.hydrate({
			id: "thread-1",
			turns: [
				{
					id: "turn-1",
					items: [
						{ type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "hi", text_elements: [] }] },
						{ type: "agentMessage", id: "a1", text: "hello", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
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

describe("ServerRequest issuer thread identification (OW-futewo)", () => {
	it("identifies a child-thread blocking request and sets issuerThreadId", () => {
		const parentThreadId = "parent-thread-id";
		const childThreadId = "child-thread-id";
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.setIdentity({ threadId: parentThreadId });

		const childBlockingRequest = unsafeMessage({
			id: "req-1",
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: childThreadId,
				turnId: "turn-1",
				itemId: "item-1",
				startedAtMs: 1000,
				command: "echo test",
			},
		});

		const effects = reducer.handle(childBlockingRequest);
		expect(effects).toHaveLength(1);
		const requestEffect = effects[0] as Extract<CodexEffect, { type: "request" }>;
		expect(requestEffect.type).toBe("request");
		expect(requestEffect.issuerThreadId).toBe(childThreadId);
	});

	it("returns null issuerThreadId for a same-thread blocking request", () => {
		const threadId = "same-thread-id";
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.setIdentity({ threadId });

		const sameThreadRequest = unsafeMessage({
			id: "req-1",
			method: "item/commandExecution/requestApproval",
			params: {
				threadId,
				turnId: "turn-1",
				itemId: "item-1",
				startedAtMs: 1000,
				command: "echo test",
			},
		});

		const effects = reducer.handle(sameThreadRequest);
		expect(effects).toHaveLength(1);
		const requestEffect = effects[0] as Extract<CodexEffect, { type: "request" }>;
		expect(requestEffect.type).toBe("request");
		expect(requestEffect.issuerThreadId).toBeNull();
	});

	it("returns null issuerThreadId for a request with no threadId in payload", () => {
		const parentThreadId = "parent-thread-id";
		const reducer = new CodexReducer({ now: () => 1 });
		reducer.setIdentity({ threadId: parentThreadId });

		const requestNoThreadId = unsafeMessage({
			id: "req-1",
			method: "item/commandExecution/requestApproval",
			params: {
				turnId: "turn-1",
				itemId: "item-1",
				startedAtMs: 1000,
				command: "echo test",
			},
		});

		const effects = reducer.handle(requestNoThreadId);
		expect(effects).toHaveLength(1);
		const requestEffect = effects[0] as Extract<CodexEffect, { type: "request" }>;
		expect(requestEffect.type).toBe("request");
		expect(requestEffect.issuerThreadId).toBeNull();
	});
});

describe("warning notifications (OW-tujiya)", () => {
	// The only one observed live is a `warning` a `turn/start` drew
	// (`codex-cli 0.156.0`, docs/MANUAL_TESTING.md, OW-wawuzu), which records
	// its message but not its `threadId`; every shape here, that one's
	// included, is read from `resources/codex-protocol/v2/`.
	const reducer = () => {
		const r = new CodexReducer({ now: () => 1 });
		r.setIdentity({ threadId: "t" });
		return r;
	};
	const cases: { message: CodexNotification; notice: Extract<CodexEffect, { type: "notice" }>["notice"] }[] = [
		{
			message: { method: "warning", params: { threadId: "t", message: "fallback metadata" } },
			notice: { kind: "warning", message: "fallback metadata", details: null, path: null },
		},
		{
			message: { method: "guardianWarning", params: { threadId: "t", message: "guarded" } },
			notice: { kind: "guardianWarning", message: "guarded", details: null, path: null },
		},
		{
			message: { method: "deprecationNotice", params: { summary: "old flag", details: "use the new one" } },
			notice: { kind: "deprecationNotice", message: "old flag", details: "use the new one", path: null },
		},
		{
			message: {
				method: "configWarning",
				params: {
					summary: "unknown key",
					details: null,
					path: "/home/u/.codex/config.toml",
					range: { start: { line: 3, column: 5 }, end: { line: 3, column: 9 } },
				},
			},
			notice: { kind: "configWarning", message: "unknown key", details: null, path: "/home/u/.codex/config.toml:3:5" },
		},
	];

	for (const { message, notice } of cases) {
		it(`surfaces ${message.method} as a notice, not an error`, () => {
			const effects = reducer().handle(message);
			expect(effects).toEqual([{ type: "notice", notice }]);
			expect(effects.some((effect) => effect.type === "error")).toBe(false);
		});
	}

	it("keeps a config warning's path when it names no range", () => {
		const effects = reducer().handle({
			method: "configWarning",
			params: { summary: "unknown key", details: "see the docs", path: "/c.toml" },
		});
		expect(effects).toEqual([
			{ type: "notice", notice: { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml" } },
		]);
	});

	it("surfaces a warning that names no thread", () => {
		expect(reducer().handle({ method: "warning", params: { threadId: null, message: "global" } })).toEqual([
			{ type: "notice", notice: { kind: "warning", message: "global", details: null, path: null } },
		]);
	});

	it("drops a warning naming another thread, which is that thread's session's", () => {
		const r = reducer();
		expect(r.handle({ method: "warning", params: { threadId: "other", message: "not ours" } })).toEqual([]);
		expect(r.handle({ method: "guardianWarning", params: { threadId: "other", message: "not ours" } })).toEqual([]);
	});
});
