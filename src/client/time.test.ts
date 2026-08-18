/**
 * The one timestamp format (OW-67).
 *
 * The load-bearing case is the first one: the session list holds an ISO string
 * and a transcript message holds epoch-ms, and the two have to render the same
 * characters. Two formatters that merely agree today would drift, so the
 * equality is asserted rather than assumed.
 */
import { describe, expect, it } from "vitest";
import { formatTimestamp, timestampIso } from "./time.ts";

/** The instant `samples.ts` starts its fixed clock at. */
const MS = 1786419855000;
const ISO = "2026-08-11T03:44:15.000Z";

describe("formatTimestamp", () => {
	it("renders epoch-ms and the equivalent ISO string identically", () => {
		expect(formatTimestamp(MS)).toBe(formatTimestamp(ISO));
	});

	it("is ISO to the second, and UTC whatever the viewer's timezone is", () => {
		// Not toLocaleString: the same session must read the same on two machines.
		expect(formatTimestamp(MS)).toBe("2026-08-11 03:44:15");
	});

	it("drops the sub-second precision the underlying value carries", () => {
		expect(formatTimestamp(MS + 400)).toBe("2026-08-11 03:44:15");
	});

	it("renders nothing at all rather than 'Invalid Date'", () => {
		expect(formatTimestamp(null)).toBe("");
		expect(formatTimestamp(undefined)).toBe("");
		expect(formatTimestamp("not a date")).toBe("");
		expect(formatTimestamp(Number.NaN)).toBe("");
	});
});

describe("timestampIso", () => {
	it("gives a <time> element its machine-readable half, from either input", () => {
		expect(timestampIso(MS)).toBe(ISO);
		expect(timestampIso(ISO)).toBe(ISO);
	});

	it("gives nothing for an unusable value, so no `datetime` attribute renders", () => {
		expect(timestampIso(null)).toBeUndefined();
		expect(timestampIso("not a date")).toBeUndefined();
	});
});
