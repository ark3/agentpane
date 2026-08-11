/**
 * Line diffs for edit-shaped tool calls.
 *
 * `diff` gives us the change runs; this turns them into display lines and
 * collapses long unchanged stretches, because an edit tool that reports a
 * 400-line file to change two of them should still render as a two-line diff
 * with a marker. Pure, so it is tested without a DOM.
 */

import { diffLines } from "diff";

export type DiffLineType = "add" | "del" | "ctx" | "gap";

export interface DiffLine {
	type: DiffLineType;
	text: string;
}

function toLines(value: string): string[] {
	const lines = value.split("\n");
	// A trailing newline produces a final empty element that is not a line.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function buildDiff(oldText: string, newText: string, context = 3): DiffLine[] {
	const raw: DiffLine[] = [];
	for (const change of diffLines(oldText, newText)) {
		const type: DiffLineType = change.added ? "add" : change.removed ? "del" : "ctx";
		for (const text of toLines(change.value)) raw.push({ type, text });
	}
	return collapse(raw, context);
}

/** Replace runs of more than `2 * context` unchanged lines with a gap marker. */
function collapse(lines: DiffLine[], context: number): DiffLine[] {
	const out: DiffLine[] = [];
	let run: DiffLine[] = [];

	const flush = (atEnd: boolean) => {
		if (run.length === 0) return;
		const atStart = out.length === 0;
		const head = atStart ? 0 : context;
		const tail = atEnd ? 0 : context;
		if (run.length > head + tail + 1) {
			out.push(...run.slice(0, head));
			out.push({ type: "gap", text: `… ${run.length - head - tail} unchanged lines` });
			if (tail > 0) out.push(...run.slice(run.length - tail));
		} else {
			out.push(...run);
		}
		run = [];
	};

	for (const line of lines) {
		if (line.type === "ctx") run.push(line);
		else {
			flush(false);
			out.push(line);
		}
	}
	flush(true);
	return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.type === "add") added++;
		else if (line.type === "del") removed++;
	}
	return { added, removed };
}
