/**
 * The one timestamp format the UI has (OW-67): ISO to the second, UTC so it
 * reads the same whatever timezone the viewer is in.
 *
 * The session list and the transcript must render byte-identically, and they
 * hold the same fact in different shapes -- `SessionSummary.updatedAt` is an
 * ISO string, a message's `timestamp` is epoch-ms -- so one function takes
 * either rather than each side formatting its own.
 */

/** Display form, `2026-08-18 12:00:00`. Empty string for anything unusable. */
export function formatTimestamp(value: string | number | null | undefined): string {
	const date = toDate(value);
	return date ? date.toISOString().slice(0, 19).replace("T", " ") : "";
}

/** The machine-readable half of a `<time>`: a full ISO string, or nothing. */
export function timestampIso(value: string | number | null | undefined): string | undefined {
	return toDate(value)?.toISOString();
}

function toDate(value: string | number | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}
