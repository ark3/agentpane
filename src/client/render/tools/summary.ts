/**
 * The one-line vocabulary shared by full tool cards and reading view's live
 * tail. Keeping it pure lets transcript shaping reuse the exact words without
 * mounting a renderer or duplicating each renderer's argument knowledge.
 */

import type { ToolCall } from "@earendil-works/pi-ai";
import { basename, oneLine } from "../types.ts";
import { argNumber, argString, editHunks, summarizeArgs } from "./args.ts";
import { buildDiff, diffStats } from "./diff.ts";

export function toolSummary(call: ToolCall): string {
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

	return oneLine(summarizeArgs(call.arguments));
}
