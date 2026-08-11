/**
 * Reading tool call arguments.
 *
 * `ToolCall.arguments` is `Record<string, any>` filled in by whichever backend
 * and model produced the call, so every access here is defensive: a tool named
 * `read` may or may not have a `path`, and a Codex `dynamicToolCall` can have
 * any shape at all. Nothing in this file may throw.
 */

export function argString(args: Record<string, unknown> | undefined, ...keys: string[]): string {
	if (!args) return "";
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
	}
	return "";
}

export function argNumber(args: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = args?.[key];
	return typeof value === "number" ? value : undefined;
}

/** One replacement inside an edit-shaped tool call. */
export interface EditHunk {
	oldText: string;
	newText: string;
}

const OLD_KEYS = ["oldText", "old_string", "old_str", "search", "old"];
const NEW_KEYS = ["newText", "new_string", "new_str", "replace", "new"];

function hunkFrom(value: unknown): EditHunk | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const oldText = argString(record, ...OLD_KEYS);
	const newText = argString(record, ...NEW_KEYS);
	return oldText || newText ? { oldText, newText } : undefined;
}

/**
 * The replacements an edit-shaped tool call describes.
 *
 * **Pi's `edit` tool nests them.** Verified against its schema in
 * `pi-coding-agent/dist/core/tools/edit.js`: the arguments are
 * `{ path, edits: [{ oldText, newText }, ...] }` -- an array, because one call
 * may carry several disjoint replacements. Reading `oldText`/`newText` off the
 * top level (as this renderer originally did) finds nothing for every real Pi
 * edit, and the tool result is no help either: it is the sentence
 * "Successfully replaced N block(s) in <path>", with the diff tucked away in
 * `details`. The flat shape is still accepted because other backends use it.
 */
export function editHunks(args: Record<string, unknown> | undefined): EditHunk[] {
	if (!args) return [];
	const nested = args.edits ?? args.replacements ?? args.changes;
	if (Array.isArray(nested)) {
		return nested.map(hunkFrom).filter((h): h is EditHunk => h !== undefined);
	}
	const flat = hunkFrom(args);
	return flat ? [flat] : [];
}

export function prettyArgs(args: Record<string, unknown> | undefined): string {
	if (!args || Object.keys(args).length === 0) return "";
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return String(args);
	}
}

/**
 * The one-line form for an unknown tool: the single argument if there is only
 * one scalar, otherwise the parameter names. Enough to tell two adjacent calls
 * apart without expanding either.
 */
export function summarizeArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const entries = Object.entries(args);
	if (entries.length === 0) return "";

	const scalars = entries.filter(
		([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
	);
	if (scalars.length === 1 && entries.length === 1) {
		const [, value] = scalars[0] as [string, unknown];
		return String(value);
	}
	if (scalars.length > 0 && scalars.length <= 3) {
		return scalars.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
	}
	return entries.map(([k]) => k).join(", ");
}
