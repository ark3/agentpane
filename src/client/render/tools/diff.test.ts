import { describe, expect, it } from "vitest";
import { buildDiff, diffStats } from "./diff.ts";

describe("buildDiff", () => {
	it("marks changed lines and keeps the rest as context", () => {
		const lines = buildDiff("a\nb\nc\n", "a\nB\nc\n");
		expect(lines.map((l) => l.type)).toEqual(["ctx", "del", "add", "ctx"]);
		expect(lines.map((l) => l.text)).toEqual(["a", "b", "B", "c"]);
	});

	it("does not invent a line for a trailing newline", () => {
		expect(buildDiff("a\n", "a\n")).toEqual([{ type: "ctx", text: "a" }]);
	});

	it("counts additions and removals", () => {
		const stats = diffStats(buildDiff("a\nb\n", "a\nb\nc\nd\n"));
		expect(stats).toEqual({ added: 2, removed: 0 });
	});

	it("collapses long unchanged runs into a gap marker", () => {
		const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const after = before.replace("line 20", "line twenty");
		const lines = buildDiff(before, after);

		expect(lines.some((l) => l.type === "gap")).toBe(true);
		// 3 lines of context on each side of the single change, plus two gaps.
		expect(lines.length).toBeLessThan(15);
		expect(lines.filter((l) => l.type === "add")).toHaveLength(1);
		expect(lines.filter((l) => l.type === "del")).toHaveLength(1);
	});

	it("keeps short unchanged runs intact", () => {
		const lines = buildDiff("a\nb\nc\nd\n", "a\nb\nc\nD\n");
		expect(lines.filter((l) => l.type === "gap")).toHaveLength(0);
	});

	it("handles a pure insertion into an empty file", () => {
		const lines = buildDiff("", "hello\n");
		expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
	});
});
