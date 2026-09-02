import { describe, expect, it } from "vitest";
import { assistant, errors, orphanResult, streamingTurn, toolRead, toolResult, user } from "./samples.ts";
import { buildTranscript, condense, readingTailStatus } from "./transcript.ts";

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

describe("condense", () => {
	const reading = (messages: Parameters<typeof buildTranscript>[0]) =>
		condense(buildTranscript(messages));

	it("drops tool results, including an orphan the full view keeps", () => {
		expect(reading(orphanResult).entries.map((e) => e.message.role)).toEqual(["assistant"]);
	});

	it("drops toolCall and thinking blocks but keeps the assistant's own text", () => {
		// streamingTurn's tail is text + a toolCall; only the text survives.
		const entries = reading(streamingTurn).entries;
		expect(entries.map((e) => e.message.role)).toEqual(["user", "assistant"]);
		const tail = entries[1]!.message as { content: { type: string }[] };
		expect(tail.content.map((block) => block.type)).toEqual(["text"]);
	});

	it("does not mutate the message it condenses", () => {
		const messages = structuredClone(streamingTurn);
		reading(messages);
		expect(messages).toEqual(streamingTurn);
	});

	it("keeps every surviving entry's original index across an elision", () => {
		// toolRead is user(0), assistant(1: thinking + toolCall), toolResult(2),
		// assistant(3: text). Entries 1 and 2 both vanish -- *before* the last
		// one -- so a condensed view that re-derived index from array position
		// would call the final assistant 1. Follow mode looks its anchor up in
		// the DOM by `[data-index]`, which is this number (App.svelte's
		// reconcile), so re-deriving it would silently strand the anchor.
		const view = reading(toolRead);
		expect(view.entries.map((e) => e.index)).toEqual([0, 3]);
		expect(view.lastIndex).toBe(3);
	});

	it("exposes the last elided tool call to streaming reading view without renumbering", () => {
		const full = buildTranscript(toolRead.slice(0, 3));
		const view = condense(full);

		expect(readingTailStatus(full, true)).toEqual({
			kind: "tool",
			name: "read",
			summary: "greeting.txt",
		});
		expect(view.entries.map((entry) => entry.index)).toEqual([0]);
	});

	it("exposes no elided-tail status when settled or when visible assistant text is live", () => {
		expect(readingTailStatus(buildTranscript(toolRead.slice(0, 3)), false)).toBeUndefined();
		const textTail = [
			user("go"),
			assistant(
				[
					{ type: "toolCall" as const, id: "call", name: "bash", arguments: { command: "pwd" } },
					{ type: "text" as const, text: "Visible answer" },
				],
				"pending",
			),
		];
		expect(readingTailStatus(buildTranscript(textTail), true)).toBeUndefined();
	});

	it("never elides the user message follow mode anchors to", () => {
		const view = reading(toolRead);
		const anchor = view.entries.find((e) => e.message.role === "user");
		expect(anchor?.index).toBe(0);
	});

	it("keeps the same key for an entry it keeps, so toggling updates the DOM in place", () => {
		const full = buildTranscript(toolRead);
		const condensed = condense(full);
		expect(condensed.entries.map((e) => e.key)).toEqual([full.entries[0]!.key, full.entries[2]!.key]);
	});

	it("drops an assistant turn left with nothing to read", () => {
		// toolRead's first assistant turn is thinking + a tool call and nothing
		// else; left in, it renders an empty article.
		expect(reading(toolRead).entries.map((e) => e.index)).not.toContain(1);
	});

	it("drops the empty placeholder of a turn that is still starting", () => {
		const view = reading([user("go"), assistant([], "pending")]);
		expect(view.entries.map((e) => e.index)).toEqual([0]);
		expect(view.lastIndex).toBe(0);
	});

	it("keeps a turn that failed or was aborted, whose banner is not tool chrome", () => {
		// `errors` ends on assistant([], "error"): no blocks to elide, but the
		// banner is the only report that the turn went wrong.
		const view = reading(errors);
		expect(view.entries.map((e) => e.index)).toEqual([0, 3]);
		expect(reading([user("go"), assistant([], "aborted")]).entries.map((e) => e.index)).toEqual([0, 1]);
	});

	it("is empty for an empty transcript", () => {
		const view = reading([]);
		expect(view.entries).toEqual([]);
		expect(view.lastIndex).toBe(-1);
	});
});
