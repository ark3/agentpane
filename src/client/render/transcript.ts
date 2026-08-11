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
