import { describe, expect, it } from "vitest";
import {
	emptySessionTurnMarks,
	foldSessionTurns,
	renameSessionTurnMarks,
} from "./session-turns.ts";

function streaming(entries: Array<[string, boolean]>): Map<string, boolean> {
	return new Map(entries);
}

describe("session finished-turn marks", () => {
	it("marks only a true-to-false transition in a session that is not selected", () => {
		let marks = emptySessionTurnMarks();
		marks = foldSessionTurns(marks, streaming([["pi:other", false]]), "pi:selected");
		expect(marks.finished.has("pi:other")).toBe(false);

		marks = foldSessionTurns(marks, streaming([["pi:other", true]]), "pi:selected");
		marks = foldSessionTurns(marks, streaming([["pi:other", false]]), "pi:selected");
		expect(marks.finished.has("pi:other")).toBe(true);
	});

	it("does not mark a selected session when its turn ends", () => {
		let marks = emptySessionTurnMarks();
		marks = foldSessionTurns(marks, streaming([["pi:selected", true]]), "pi:selected");
		marks = foldSessionTurns(marks, streaming([["pi:selected", false]]), "pi:selected");
		expect(marks.finished.has("pi:selected")).toBe(false);
	});

	it("clears a retained mark when its session becomes selected", () => {
		let marks = emptySessionTurnMarks();
		marks = foldSessionTurns(marks, streaming([["pi:other", true]]), "pi:selected");
		marks = foldSessionTurns(marks, streaming([["pi:other", false]]), "pi:selected");
		marks = foldSessionTurns(marks, streaming([["pi:other", false]]), "pi:other");
		expect(marks.finished.has("pi:other")).toBe(false);
	});

	it("carries both an observed stream and a finished mark across D9 rename", () => {
		let streamingMarks = emptySessionTurnMarks();
		streamingMarks = foldSessionTurns(
			streamingMarks,
			streaming([["pi:draft", true]]),
			"pi:selected",
		);
		streamingMarks = renameSessionTurnMarks(streamingMarks, "pi:draft", "pi:named");
		streamingMarks = foldSessionTurns(
			streamingMarks,
			streaming([["pi:named", false]]),
			"pi:selected",
		);
		expect(streamingMarks.finished.has("pi:named")).toBe(true);

		const renamedFinished = renameSessionTurnMarks(streamingMarks, "pi:named", "pi:again");
		expect(renamedFinished.finished.has("pi:named")).toBe(false);
		expect(renamedFinished.finished.has("pi:again")).toBe(true);
	});
});
