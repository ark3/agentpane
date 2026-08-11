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
