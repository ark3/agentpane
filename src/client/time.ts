/**
 * The one timestamp format the UI has (OW-67): ISO to the second, in the
 * browser's local zone (OW-70). The viewer is one person on one machine
 * reading their own sessions, so there is nobody for a UTC rendering to be
 * portable *to* -- it just costs an offset calculation per line. In the
 * two-machine setup the browser's zone is the one that matches the reader's
 * wall clock whichever machine served the bytes.
 *
 * The session list and the transcript must render byte-identically, and they
 * hold the same fact in different shapes -- `SessionSummary.updatedAt` is an
 * ISO string, a message's `timestamp` is epoch-ms -- so one function takes
 * either rather than each side formatting its own.
 */

/** Display form, `2026-08-18 12:00:00`. Empty string for anything unusable. */
export function formatTimestamp(value: string | number | null | undefined): string {
	const date = toDate(value);
	if (!date) return "";
	// Padded local components, not `toLocaleString`: the shape has to stay
	// `YYYY-MM-DD HH:MM:SS`, and `toLocaleString`'s moves with the locale.
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The machine-readable half of a `<time>`: a full ISO string, or nothing. This
 * one stays UTC -- `datetime` is for an absolute instant (OW-70).
 */
export function timestampIso(value: string | number | null | undefined): string | undefined {
	return toDate(value)?.toISOString();
}

function toDate(value: string | number | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}
