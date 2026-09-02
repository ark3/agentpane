/**
 * Turning `AgentMessage[]` into the list the transcript actually draws.
 *
 * Two things happen here, both pure so they can be tested without a DOM:
 *
 * 1. **Tool results are folded into their tool call.** A `ToolResultMessage`
 *    is a top-level message in the transcript, but reading it as one is
 *    terrible -- the call says `bash(echo …)` and the answer shows up as a
 *    separate card below. So results are indexed by `toolCallId` and the
 *    matched ones are hidden from the top level; the tool card renders them.
 *    A result with no matching call still renders on its own (that is the
 *    `tool-result` role chrome), because a truncated or forked transcript can
 *    legitimately start mid-turn.
 *
 * 2. **Keys.** D3 upserts by index, so index *is* identity for a live
 *    transcript; the role and timestamp are folded in so a snapshot that
 *    replaces the array does not accidentally reuse DOM across message kinds.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { oneLine } from "./types.ts";
import { toolSummary } from "./tools/summary.ts";

export interface TranscriptEntry {
	/** Stable `{#each}` key. */
	key: string;
	/** Index in the original `messages` array. */
	index: number;
	message: AgentMessage;
}

export interface TranscriptView {
	entries: TranscriptEntry[];
	/** Every tool result in the transcript, by the call it answers. */
	results: Map<string, ToolResultMessage>;
	/** Index of the final visible entry, or -1. Only that one can be streaming. */
	lastIndex: number;
}

export type ReadingTailStatus =
	| { kind: "tool"; name: string; summary: string }
	| { kind: "thinking"; name: "Thinking"; summary: string };

function keyFor(message: AgentMessage, index: number): string {
	const role = "role" in message ? String(message.role) : "unknown";
	const stamp = "timestamp" in message ? String(message.timestamp) : "";
	return `${index}:${role}:${stamp}`;
}

export function buildTranscript(messages: AgentMessage[]): TranscriptView {
	const results = new Map<string, ToolResultMessage>();
	const answered = new Set<string>();

	for (const message of messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, message);
		else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") answered.add(block.id);
			}
		}
	}

	const entries: TranscriptEntry[] = [];
	messages.forEach((message, index) => {
		// Hide only results whose call is present -- an orphan still renders.
		if (message.role === "toolResult" && answered.has(message.toolCallId)) return;
		entries.push({ key: keyFor(message, index), index, message });
	});

	return { entries, results, lastIndex: entries[entries.length - 1]?.index ?? -1 };
}

/**
 * The last live fact reading view would otherwise hide.
 *
 * Stop at visible assistant prose or the current user turn: an older tool is
 * not the live tail in either case. Empty assistant placeholders and folded
 * tool results do not end the search because both can arrive immediately
 * after the call while that same tool phase is still live.
 */
export function readingTailStatus(
	view: TranscriptView,
	isStreaming: boolean,
): ReadingTailStatus | undefined {
	if (!isStreaming) return undefined;

	for (let entryIndex = view.entries.length - 1; entryIndex >= 0; entryIndex--) {
		const message = view.entries[entryIndex]!.message;
		if (message.role === "user") return undefined;
		if (message.role !== "assistant") continue;

		for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = message.content[blockIndex]!;
			if (block.type === "text" && block.text.trim()) return undefined;
			if (block.type === "toolCall") {
				return { kind: "tool", name: block.name, summary: toolSummary(block) };
			}
			if (block.type === "thinking") {
				return {
					kind: "thinking",
					name: "Thinking",
					summary: block.redacted ? "redacted by the provider" : oneLine(block.thinking, 80),
				};
			}
		}
	}

	return undefined;
}

/**
 * Reading view (OW-51): the same transcript with the tool chrome elided --
 * tool results, tool calls, thinking -- so the prose can be scrolled back
 * through while the session is still running.
 *
 * It filters a *built* view rather than the raw messages, and that is the
 * whole point of the signature. `TranscriptEntry.index` is a position in the
 * original `messages` array, and follow mode finds its anchor in the DOM by
 * exactly that number (`App.svelte`'s `reconcile`, via `[data-index]`).
 * Filtering keeps those indices; re-deriving them from the condensed array
 * would renumber every entry after an elision and strand the anchor. The
 * anchor is always a user message, which is never elided.
 */
export function condense(view: TranscriptView): TranscriptView {
	const entries: TranscriptEntry[] = [];

	for (const entry of view.entries) {
		const message = entry.message;
		if (message.role === "toolResult") continue; // orphans included: it is all tool chrome
		if (message.role !== "assistant") {
			entries.push(entry);
			continue;
		}

		const content = message.content.filter(
			(block) => block.type !== "toolCall" && block.type !== "thinking",
		);
		// A turn that was only tool calls and thinking has nothing left to read;
		// left in it renders an empty article or a bare cursor. Transcript.svelte
		// draws the live elided tail separately, without changing entry identity.
		// A failed or aborted turn is the exception: its banner is not tool
		// chrome, and dropping it would hide that the turn ended badly.
		const banner = message.stopReason === "error" || message.stopReason === "aborted";
		if (content.length === 0 && !banner) continue;

		// Same key, so toggling reading view updates the surviving DOM in place.
		entries.push({ ...entry, message: { ...message, content } });
	}

	return { entries, results: view.results, lastIndex: entries[entries.length - 1]?.index ?? -1 };
}
