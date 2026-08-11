/**
 * `ToolCall.arguments` is `Record<string, any>` filled in by a model, so these
 * readers are the seam where a wrong assumption about a backend's tool schema
 * shows up as an empty card rather than a crash. The shapes asserted here were
 * read off the tools themselves, not guessed -- see `editHunks`.
 */
import { describe, expect, it } from "vitest";
import { argNumber, argString, editHunks, prettyArgs, summarizeArgs } from "./args.ts";

describe("argString", () => {
	it("returns the first key that holds a scalar", () => {
		expect(argString({ b: "second" }, "a", "b")).toBe("second");
		expect(argString({ a: 3 }, "a")).toBe("3");
		expect(argString({ a: false }, "a")).toBe("false");
	});

	it("returns empty for a missing key, a missing bag, or a non-scalar", () => {
		expect(argString(undefined, "a")).toBe("");
		expect(argString({}, "a")).toBe("");
		expect(argString({ a: { nested: true } }, "a")).toBe("");
		expect(argString({ a: null }, "a")).toBe("");
	});
});

describe("argNumber", () => {
	it("reads numbers only", () => {
		expect(argNumber({ offset: 12 }, "offset")).toBe(12);
		expect(argNumber({ offset: "12" }, "offset")).toBeUndefined();
		expect(argNumber(undefined, "offset")).toBeUndefined();
	});
});

describe("editHunks", () => {
	it("reads Pi's nested `edits` array", () => {
		// Pi's schema, verified in pi-coding-agent/dist/core/tools/edit.js:
		// { path, edits: [{ oldText, newText }, ...] }
		expect(
			editHunks({
				path: "src/greet.ts",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "c", newText: "d" },
				],
			}),
		).toEqual([
			{ oldText: "a", newText: "b" },
			{ oldText: "c", newText: "d" },
		]);
	});

	it("reads the flat shape other backends use", () => {
		expect(editHunks({ file_path: "x", old_string: "a", new_string: "b" })).toEqual([
			{ oldText: "a", newText: "b" },
		]);
		expect(editHunks({ path: "x", oldText: "a", newText: "b" })).toEqual([
			{ oldText: "a", newText: "b" },
		]);
	});

	it("keeps a pure insertion and a pure deletion", () => {
		expect(editHunks({ edits: [{ oldText: "", newText: "added" }] })).toEqual([
			{ oldText: "", newText: "added" },
		]);
		expect(editHunks({ edits: [{ oldText: "gone", newText: "" }] })).toEqual([
			{ oldText: "gone", newText: "" },
		]);
	});

	it("returns nothing rather than throwing on a shape it does not know", () => {
		expect(editHunks(undefined)).toEqual([]);
		expect(editHunks({})).toEqual([]);
		expect(editHunks({ path: "x" })).toEqual([]);
		expect(editHunks({ edits: "not an array" })).toEqual([]);
		expect(editHunks({ edits: [null, 7, "x", {}] })).toEqual([]);
	});
});

describe("summarizeArgs", () => {
	it("gives the bare value when there is exactly one argument", () => {
		expect(summarizeArgs({ city: "Boston" })).toBe("Boston");
	});

	it("names a few scalars", () => {
		expect(summarizeArgs({ city: "Boston", units: "metric" })).toBe("city: Boston, units: metric");
	});

	it("falls back to parameter names when there are many or none are scalar", () => {
		expect(summarizeArgs({ a: 1, b: 2, c: 3, d: 4 })).toBe("a, b, c, d");
		expect(summarizeArgs({ payload: { deep: true } })).toBe("payload");
	});

	it("is empty for nothing to say", () => {
		expect(summarizeArgs(undefined)).toBe("");
		expect(summarizeArgs({})).toBe("");
	});
});

describe("prettyArgs", () => {
	it("pretty-prints", () => {
		expect(prettyArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	it("does not throw on a cyclic bag", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => prettyArgs(cyclic)).not.toThrow();
	});

	it("is empty for nothing to show", () => {
		expect(prettyArgs(undefined)).toBe("");
		expect(prettyArgs({})).toBe("");
	});
});
