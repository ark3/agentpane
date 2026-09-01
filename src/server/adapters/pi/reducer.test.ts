/**
 * Feeds real recorded Pi RPC turns (resources/fixtures/pi/) through the pure
 * reducer and asserts on structure -- event sequence, message roles,
 * content-block kinds, tool call/result pairing, stopReason -- never on
 * exact model wording (WORKSTREAMS.md, HANDOFF.md: fixture text varies per
 * capture). See resources/fixtures/README.md for what each scenario covers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	buildUiReplyCommand,
	createInitialPiState,
	type PiReduceResult,
	type PiReducerState,
	reducePiNotification,
} from "./reducer.ts";
import type { PiNotification, PiOutputLine } from "./protocol.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../../resources/fixtures/pi/", import.meta.url));

function readFixture(name: string): PiOutputLine[] {
	const text = readFileSync(`${FIXTURES_DIR}${name}`, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as PiOutputLine);
}

/**
 * Mirrors process.ts's own dispatch: "response" lines are command
 * correlation, not part of the message stream, and never reach the reducer.
 * Returns the final state plus every intermediate result, so tests can
 * assert on the sequence of changedIndex/request/error signals too.
 */
function runThroughReducer(lines: PiOutputLine[]): { finalState: PiReducerState; results: PiReduceResult[] } {
	let state = createInitialPiState();
	const results: PiReduceResult[] = [];
	for (const line of lines) {
		if (line.type === "response") continue;
		const result = reducePiNotification(state, line as PiNotification);
		results.push(result);
		state = result.state;
	}
	return { finalState: state, results };
}

describe("reducePiNotification: text fixture (streaming text, no tools)", () => {
	const lines = readFixture("text.jsonl");

	it("assembles exactly a user message and an assistant message", () => {
		const { finalState } = runThroughReducer(lines);
		expect(finalState.messages).toHaveLength(2);
		expect(finalState.messages[0]?.role).toBe("user");
		expect(finalState.messages[1]?.role).toBe("assistant");
	});

	it("ends with isStreaming false (agent_settled, not agent_end, is terminal)", () => {
		const { finalState } = runThroughReducer(lines);
		expect(finalState.isStreaming).toBe(false);
	});

	it("goes streaming after agent_start and stays streaming through agent_end", () => {
		let state = createInitialPiState();
		for (const line of lines) {
			if (line.type === "response") continue;
			state = reducePiNotification(state, line as PiNotification).state;
			if (line.type === "agent_end") {
				// DESIGN/HANDOFF: agent_end is not the terminal signal -- a retry,
				// compaction, or queued continuation could still follow it.
				expect(state.isStreaming).toBe(true);
			}
		}
	});

	it("assembles the streaming text block by contentIndex, matching the fixture's own deltas", () => {
		let state = createInitialPiState();
		let expectedText = "";
		for (const line of lines) {
			if (line.type === "response") continue;
			state = reducePiNotification(state, line as PiNotification).state;
			if (line.type === "message_update" && line.assistantMessageEvent.type === "text_delta") {
				expectedText += line.assistantMessageEvent.delta;
				const last = state.messages.at(-1) as AssistantMessage;
				const block = last.content[line.assistantMessageEvent.contentIndex] as TextContent;
				expect(block.type).toBe("text");
				expect(block.text).toBe(expectedText);
			}
		}
	});

	it("message_end is authoritative: the final assistant text matches message_end's own message verbatim", () => {
		const { finalState } = runThroughReducer(lines);
		const messageEndEvent = lines.find((l) => l.type === "message_end" && l.message.role === "assistant");
		expect(messageEndEvent?.type).toBe("message_end");
		if (messageEndEvent?.type !== "message_end") throw new Error("unreachable");
		expect(finalState.messages.at(-1)).toEqual(messageEndEvent.message);
	});

	it("stopReason on the final assistant message is stop (no tool use)", () => {
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		expect(assistant.stopReason).toBe("stop");
	});

	it("reports changedIndex 0 then 1 as the user and assistant messages arrive", () => {
		const { results } = runThroughReducer(lines);
		const withIndex = results.filter((r) => r.changedIndex !== undefined).map((r) => r.changedIndex);
		expect(withIndex[0]).toBe(0); // user message_start
		expect(withIndex.at(-1)).toBe(1); // assistant message_end
		expect(new Set(withIndex)).toEqual(new Set([0, 1]));
	});

	it("raises no request or error signals for a clean text turn", () => {
		const { results } = runThroughReducer(lines);
		expect(results.every((r) => r.request === undefined)).toBe(true);
		expect(results.every((r) => r.error === undefined)).toBe(true);
	});
});

describe("reducePiNotification: compact fixture (manual compaction, OW-72)", () => {
	const lines = readFixture("compact.jsonl");

	/** The compaction_end the capture recorded, with its result payload. */
	function compactionEnd(): Extract<PiNotification, { type: "compaction_end" }> {
		const event = lines.find((l) => l.type === "compaction_end");
		if (event?.type !== "compaction_end") throw new Error("fixture has no compaction_end");
		return event;
	}

	it("the fixture actually compacted: compaction_end carries a result, not an error", () => {
		// Guards the fixture itself. Pi refuses to compact a session under
		// keepRecentTokens ("Nothing to compact"), so a stale capture would carry
		// an errorMessage and null result -- and every assertion below would be
		// vacuous. Assert the shape, never the summary wording.
		const end = compactionEnd();
		expect(end.result).not.toBeNull();
		expect(end.result?.tokensBefore).toBeGreaterThan(end.result?.estimatedTokensAfter ?? 0);
	});

	it("appends exactly one compactionSummary message carrying the summary and tokensBefore", () => {
		const before = runThroughReducer(lines.filter((l) => l.type !== "compaction_end"));
		const after = runThroughReducer(lines);
		// The whole effect of compaction_end is one extra message, at the end.
		expect(after.finalState.messages).toHaveLength(before.finalState.messages.length + 1);
		const summary = after.finalState.messages.at(-1);
		const end = compactionEnd();
		expect(summary).toMatchObject({
			role: "compactionSummary",
			summary: end.result?.summary,
			tokensBefore: end.result?.tokensBefore,
		});
	});

	it("reports the appended summary via changedIndex and raises no error", () => {
		const { results, finalState } = runThroughReducer(lines);
		const endResult = results.at(-1);
		expect(endResult?.error).toBeUndefined();
		expect(endResult?.changedIndex).toBe(finalState.messages.length - 1);
	});

	it("enters running once and clears it in the update that appends the marker", () => {
		const { results } = runThroughReducer(lines);
		let previous: PiReducerState["compaction"] = null;
		const transitions = results.filter((result) => {
			const changed = result.state.compaction !== previous;
			previous = result.state.compaction;
			return changed;
		}).map((result) => ({ compaction: result.state.compaction, changedIndex: result.changedIndex }));
		expect(transitions).toEqual([
			{ compaction: "running", changedIndex: undefined },
			{ compaction: null, changedIndex: results.at(-1)?.changedIndex },
		]);
	});

	it("an automatic threshold start enters running without a requesting phase", () => {
		const initial = createInitialPiState();
		const result = reducePiNotification(initial, { type: "compaction_start", reason: "threshold" });
		expect(initial.compaction).toBeNull();
		expect(result.state.compaction).toBe("running");
	});
});

describe("reducePiNotification: tool-read fixture (tool call + result pair)", () => {
	const lines = readFixture("tool-read.jsonl");

	it("assembles user -> assistant(toolCall) -> toolResult -> assistant(text)", () => {
		const { finalState } = runThroughReducer(lines);
		expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("the tool-calling assistant message carries a thinking block and a toolCall block", () => {
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		expect(assistant.content.map((c) => c.type)).toEqual(["thinking", "toolCall"]);
		expect(assistant.stopReason).toBe("toolUse");
	});

	it("Pi used the read tool, and the toolCall is fully assembled by toolcall_end", () => {
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		const toolCall = assistant.content[1] as ToolCall;
		expect(toolCall.type).toBe("toolCall");
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toEqual({ path: "greeting.txt" });
		expect(toolCall.id).not.toBe(""); // toolcall_start's placeholder id was replaced

		const toolCallEndEvent = lines.find((l) => l.type === "message_update" && l.assistantMessageEvent.type === "toolcall_end");
		expect(toolCallEndEvent?.type).toBe("message_update");
		if (toolCallEndEvent?.type !== "message_update" || toolCallEndEvent.assistantMessageEvent.type !== "toolcall_end") {
			throw new Error("unreachable");
		}
		expect(toolCall).toEqual(toolCallEndEvent.assistantMessageEvent.toolCall);
	});

	it("the toolResult message correlates to the toolCall by id, and carries the tool's own name", () => {
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		const toolCall = assistant.content[1] as ToolCall;
		const toolResult = finalState.messages[2] as ToolResultMessage;
		expect(toolResult.toolCallId).toBe(toolCall.id);
		expect(toolResult.toolName).toBe("read");
		expect(toolResult.isError).toBe(false);
	});

	it("the follow-up assistant message is plain text with stopReason stop", () => {
		const { finalState } = runThroughReducer(lines);
		const followUp = finalState.messages[3] as AssistantMessage;
		expect(followUp.content.map((c) => c.type)).toEqual(["text"]);
		expect(followUp.stopReason).toBe("stop");
	});

	it("ends settled, not streaming", () => {
		const { finalState } = runThroughReducer(lines);
		expect(finalState.isStreaming).toBe(false);
	});

	it("thinking block assembles by contentIndex the same way text does", () => {
		let state = createInitialPiState();
		let expectedThinking = "";
		for (const line of lines) {
			if (line.type === "response") continue;
			state = reducePiNotification(state, line as PiNotification).state;
			if (line.type === "message_update" && line.assistantMessageEvent.type === "thinking_delta") {
				expectedThinking += line.assistantMessageEvent.delta;
				const last = state.messages.at(-1) as AssistantMessage;
				const block = last.content[line.assistantMessageEvent.contentIndex] as ThinkingContent;
				expect(block.thinking).toBe(expectedThinking);
			}
		}
	});
});

describe("reducePiNotification: tool-edit fixture (Pi chose bash, not a dedicated edit tool)", () => {
	const lines = readFixture("tool-edit.jsonl");

	it("assembles user -> assistant(toolCall) -> toolResult -> assistant(text)", () => {
		const { finalState } = runThroughReducer(lines);
		expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("the tool used is bash, not a dedicated edit tool -- the tool vocabulary is not fixed (DESIGN D5)", () => {
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		const toolCall = assistant.content[0] as ToolCall;
		expect(toolCall.type).toBe("toolCall");
		expect(toolCall.name).toBe("bash");
		expect(typeof toolCall.arguments.command).toBe("string");
	});

	it("toolcall_delta events (raw partial JSON) do not corrupt the assembled arguments", () => {
		// tool-edit's toolcall arguments stream in many small chunks (a
		// multi-word bash command). If a partial-JSON delta ever leaked into
		// the assembled content, arguments would either throw or be garbage;
		// it must instead exactly match toolcall_end's own parsed object.
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		const toolCall = assistant.content[0] as ToolCall;
		const toolcallDeltaCount = lines.filter(
			(l) => l.type === "message_update" && l.assistantMessageEvent.type === "toolcall_delta",
		).length;
		expect(toolcallDeltaCount).toBeGreaterThan(1);
		expect(toolCall.arguments.command).toBe("echo 'goodbye' >> greeting.txt && cat greeting.txt");
	});

	it("the tool result reflects the bash output and correlates by id", () => {
		const { finalState } = runThroughReducer(lines);
		const assistant = finalState.messages[1] as AssistantMessage;
		const toolCall = assistant.content[0] as ToolCall;
		const toolResult = finalState.messages[2] as ToolResultMessage;
		expect(toolResult.toolCallId).toBe(toolCall.id);
		expect(toolResult.toolName).toBe("bash");
	});

	it("ends settled, not streaming", () => {
		const { finalState } = runThroughReducer(lines);
		expect(finalState.isStreaming).toBe(false);
	});
});

describe("reducePiNotification: extension UI dialog requests (hand-crafted -- no fixture covers this)", () => {
	it("select: surfaces a request and records the pending method for reply()", () => {
		const state = createInitialPiState();
		const result = reducePiNotification(state, {
			type: "extension_ui_request",
			id: "req-1",
			method: "select",
			title: "Allow dangerous command?",
			options: ["Allow", "Block"],
		});
		expect(result.request).toEqual({
			requestId: "req-1",
			kind: "select",
			payload: { title: "Allow dangerous command?", options: ["Allow", "Block"] },
		});
		expect(result.state.pendingUiRequests["req-1"]).toBe("select");
	});

	it("buildUiReplyCommand: select/input/editor reply with value, confirm replies with confirmed", () => {
		expect(buildUiReplyCommand("select", "req-1", "Allow")).toEqual({
			type: "extension_ui_response",
			id: "req-1",
			value: "Allow",
		});
		expect(buildUiReplyCommand("confirm", "req-2", true)).toEqual({
			type: "extension_ui_response",
			id: "req-2",
			confirmed: true,
		});
	});

	it("buildUiReplyCommand: a null response cancels regardless of method", () => {
		expect(buildUiReplyCommand("select", "req-1", null)).toEqual({
			type: "extension_ui_response",
			id: "req-1",
			cancelled: true,
		});
		expect(buildUiReplyCommand("confirm", "req-2", null)).toEqual({
			type: "extension_ui_response",
			id: "req-2",
			cancelled: true,
		});
	});

	it("fire-and-forget methods (notify) do not produce a request or mutate state", () => {
		const state = createInitialPiState();
		const result = reducePiNotification(state, {
			type: "extension_ui_request",
			id: "req-3",
			method: "notify",
			message: "Command blocked by user",
		});
		expect(result.request).toBeUndefined();
		expect(result.state).toBe(state); // no-op: same reference, nothing pending
	});
});

describe("reducePiNotification: error signals not covered by any fixture", () => {
	it("extension_error surfaces as an adapter error", () => {
		const state = createInitialPiState();
		const result = reducePiNotification(state, {
			type: "extension_error",
			extensionPath: "/home/user/.pi/agent/extensions/foo.ts",
			event: "tool_call",
			error: "boom",
		});
		expect(result.error).toContain("boom");
		expect(result.state).toBe(state);
	});

	it("auto_retry_end with success:false surfaces finalError", () => {
		const state = createInitialPiState();
		const result = reducePiNotification(state, {
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "529 overloaded_error: Overloaded",
		});
		expect(result.error).toBe("529 overloaded_error: Overloaded");
	});

	it("auto_retry_end with success:true is a no-op", () => {
		const state = createInitialPiState();
		const result = reducePiNotification(state, { type: "auto_retry_end", success: true, attempt: 2 });
		expect(result.error).toBeUndefined();
		expect(result.state).toBe(state);
	});
});

describe("reducePiNotification: unknown/no-op notifications never throw and don't churn state", () => {
	it("turn_start, tool_execution_*, queue_update all return the same state reference", () => {
		const state = createInitialPiState();
		const noopEvents: PiNotification[] = [
			{ type: "turn_start" },
			{ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} },
			{ type: "tool_execution_update", toolCallId: "x", toolName: "bash", args: {}, partialResult: {} },
			{ type: "tool_execution_end", toolCallId: "x", toolName: "bash", result: {}, isError: false },
			{ type: "queue_update", steering: [], followUp: [] },
			{ type: "bash_execution_update", delta: "output" },
		];
		for (const event of noopEvents) {
			const result = reducePiNotification(state, event);
			expect(result.state).toBe(state);
			expect(result.changedIndex).toBeUndefined();
		}
	});
});
