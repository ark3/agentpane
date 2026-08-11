/** Shared text helpers for turning raw message text into a display preview. */

const PREVIEW_MAX_LENGTH = 200;

export function trimPreview(text: string, maxLength = PREVIEW_MAX_LENGTH): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
