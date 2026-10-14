import { describe, expect, it } from "vitest";
import { systemChanged, systemLeading, user } from "./samples.ts";
import { leadingSystemIndex, systemView, unprompted } from "./system.ts";
import { buildTranscript } from "./transcript.ts";

describe("systemView (OW-wavini)", () => {
	it("counts what the leading message declares", () => {
		expect(systemView(systemLeading(), true).summary).toBe("System prompt · 5 sections · 4 tools");
	});

	it("says when the leading message carries instructions of its own, as a reloaded compaction's can", () => {
		expect(systemView({ ...systemLeading(), content: "Be terse." }, true).summary).toBe(
			"System prompt · instructions · 5 sections · 4 tools",
		);
	});

	it("names what a later message changes, a removed section and tool marked so", () => {
		expect(systemView(systemChanged(), false).summary).toBe(
			"System prompt changed · addendum, −docs · tools −edit −write",
		);
	});

	it("keeps sections in order, null for a removed one, and tools without their schemas", () => {
		const view = systemView(systemChanged(), false);
		expect(view.sections).toEqual([
			{ name: "addendum", text: expect.any(String) },
			{ name: "docs", text: null },
		]);
		expect(view.toolsRemoved).toEqual(["edit", "write"]);
		expect(Object.keys(systemView(systemLeading(), true).toolsAdded[0]!)).toEqual(["name", "description"]);
	});

	it("finds the first system message as the leading one, by its index in the messages", () => {
		expect(leadingSystemIndex(buildTranscript([user("hi"), systemLeading(), systemChanged()]))).toBe(1);
		expect(leadingSystemIndex(buildTranscript([user("hi")]))).toBe(-1);
	});
});

describe("unprompted (OW-widozi)", () => {
	it.each([
		["no transcript", false, undefined],
		["an empty transcript", true, []],
		["a leading system message alone", true, [systemLeading()]],
		["a system message and a user message", false, [systemLeading(), user("Fix the bug")]],
		["a user message", false, [user("Fix the bug")]],
	])("reads %s as unprompted: %s", (_name, expected, messages) => {
		expect(unprompted(messages)).toBe(expected);
	});
});
