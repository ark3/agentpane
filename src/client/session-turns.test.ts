import { describe, expect, it } from "vitest";
import {
	emptySessionTurnMarks,
	foldSessionTurns,
	moveSessionTurnMarks,
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

	it("does not mark a session when no other session is selected", () => {
		let marks = emptySessionTurnMarks();
		marks = foldSessionTurns(marks, streaming([["pi:unselected", true]]), null);
		marks = foldSessionTurns(marks, streaming([["pi:unselected", false]]), null);
		expect(marks.finished.has("pi:unselected")).toBe(false);
	});

	it("clears a retained mark when its session becomes selected", () => {
		let marks = emptySessionTurnMarks();
		marks = foldSessionTurns(marks, streaming([["pi:other", true]]), "pi:selected");
		marks = foldSessionTurns(marks, streaming([["pi:other", false]]), "pi:selected");
		marks = foldSessionTurns(marks, streaming([["pi:other", false]]), "pi:other");
		expect(marks.finished.has("pi:other")).toBe(false);
	});

	// Keys are handles (D24), so a rename never moves one; a fork, which is
	// another session under another handle, is what `App.svelte` still moves a
	// key for.
	it("carries both an observed stream and a finished mark from a fork's parent to the fork", () => {
		let streamingMarks = emptySessionTurnMarks();
		streamingMarks = foldSessionTurns(
			streamingMarks,
			streaming([["h-parent", true]]),
			"h-selected",
		);
		streamingMarks = moveSessionTurnMarks(streamingMarks, "h-parent", "h-fork");
		streamingMarks = foldSessionTurns(
			streamingMarks,
			streaming([["h-fork", false]]),
			"h-selected",
		);
		expect(streamingMarks.finished.has("h-fork")).toBe(true);

		const movedFinished = moveSessionTurnMarks(streamingMarks, "h-fork", "h-again");
		expect(movedFinished.finished.has("h-fork")).toBe(false);
		expect(movedFinished.finished.has("h-again")).toBe(true);
	});
});
