/**
 * The one-line vocabulary shared by full tool cards and reading view's live
 * tail. Keeping it pure lets transcript shaping reuse the exact words without
 * mounting a renderer or duplicating each renderer's argument knowledge.
 */

import type { ToolCall } from "@earendil-works/pi-ai";
import { shortThreadId } from "$shared/thread-id.ts";
import { basename, oneLine } from "../types.ts";
import { argNumber, argString, editHunks, summarizeArgs } from "./args.ts";
import { buildDiff, diffStats } from "./diff.ts";

/**
 * Always one line, whatever the call's arguments hold: a file name or a
 * collab operation name may carry a newline or a tab, and Emacs fits its
 * header to one screen line by a measure that sees only a string's widest
 * line (OW-gogona). Collapsed without `oneLine`'s cut, so a long file name is
 * not shortened here; each client cuts the line to fit.
 */
export function toolSummary(call: ToolCall): string {
	return summarize(call).replace(/\s+/g, " ").trim();
}

function summarize(call: ToolCall): string {
	const name = call.name.toLowerCase();
	if (name === "bash" || name === "shell") {
		return oneLine(argString(call.arguments, "command", "cmd", "script")) || "shell";
	}

	const path = argString(call.arguments, "path", "file", "filePath", "file_path");
	if (name === "read") {
		const offset = argNumber(call.arguments, "offset");
		const limit = argNumber(call.arguments, "limit");
		return [
			basename(path),
			offset === undefined ? "" : `offset ${offset}`,
			limit === undefined ? "" : `limit ${limit}`,
		]
			.filter(Boolean)
			.join(" · ");
	}

	if (name === "write") {
		const content = argString(call.arguments, "content", "text", "newText");
		return [basename(path), content ? `${content.split("\n").length} lines` : ""]
			.filter(Boolean)
			.join(" · ");
	}

	if (name === "edit") {
		const diffs = editHunks(call.arguments).map((hunk) => buildDiff(hunk.oldText, hunk.newText));
		const stats = diffStats(diffs.flat());
		return [basename(path), diffs.length ? `+${stats.added} −${stats.removed}` : ""]
			.filter(Boolean)
			.join(" · ");
	}

	if (name === "subagent") {
		// A Codex collab call: the operation, then enough of each child thread's
		// uuid to tell two apart without eating the line -- `shortThreadId`, the
		// same form the result body prefixes each child's reply with. Empty
		// thread ids on a spawn's `item/started` leave just the operation.
		return [argString(call.arguments, "tool"), ...subagentThreadIds(call).map(shortThreadId)].join(" · ");
	}

	return oneLine(summarizeArgs(call.arguments));
}

/** The child threads a collab call names: only the string entries, none when absent. */
export function subagentThreadIds(call: ToolCall): string[] {
	const ids = call.arguments["threadIds"];
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}
