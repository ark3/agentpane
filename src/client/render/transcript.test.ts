import { describe, expect, it } from "vitest";
import { assistant, orphanResult, toolRead, toolResult, user } from "./samples.ts";
import { buildTranscript } from "./transcript.ts";

describe("buildTranscript", () => {
	it("indexes tool results by the call they answer", () => {
		const view = buildTranscript(toolRead);
		expect(view.results.get("call_read_1")?.toolName).toBe("read");
	});

	it("hides a tool result whose call is in the transcript", () => {
		const view = buildTranscript(toolRead);
		expect(view.entries.map((e) => e.message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
		]);
	});

	it("keeps an orphan tool result as its own entry", () => {
		const view = buildTranscript(orphanResult);
		expect(view.entries.map((e) => e.message.role)).toEqual(["toolResult", "assistant"]);
	});

	it("reports the original index of the last visible entry", () => {
		// toolRead is user, assistant, toolResult, assistant -- the folded
		// result must not make the tail index 2.
		const view = buildTranscript(toolRead);
		expect(view.lastIndex).toBe(3);
	});

	it("is empty for an empty transcript", () => {
		const view = buildTranscript([]);
		expect(view.entries).toEqual([]);
		expect(view.lastIndex).toBe(-1);
	});

	it("gives every entry a distinct key", () => {
		const messages = [
			user("a"),
			user("a"),
			assistant([{ type: "text", text: "b" }]),
			toolResult("unmatched", "read", "x"),
		];
		const keys = buildTranscript(messages).entries.map((e) => e.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
