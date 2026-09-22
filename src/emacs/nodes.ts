/**
 * Projecting a transcript onto the nodes the native Emacs mode draws
 * (OW-mutufa). The contract is `protocol.ts`; this is the one place that
 * produces it.
 *
 * Pure, and built from the browser's own render helpers rather than beside
 * them: `buildTranscript` folds tool results into their calls exactly as
 * `Transcript.svelte` does, `toolSummary`/`prettyArgs`/`buildDiff` supply the
 * words and lines the tool cards show, and `toolState` decides running/ok/
 * error the same way. Two callers share one per-entry projection:
 *
 * - `projectTranscript` maps a whole transcript, for a snapshot or a preview.
 * - `projectUpsert` maps one `upsert` to the one node it replaces, whole. The
 *   subtlety is that an upsert is not always its own node: a tool result folds
 *   into an earlier call's node, so the function takes the transcript so far,
 *   applies the upsert to a copy, and answers with the node that changed --
 *   the call's, for a folded result; its own otherwise.
 *
 * `streaming` for a tool call is the browser's rule, verbatim from
 * `Transcript.svelte`: the session's own `isStreaming` status, and the entry
 * is the last visible one. Not `stopReason === "pending"` -- Pi marks a live
 * turn that way, but the Claude reducer opens every assistant slot with
 * `"stop"`, so a rule read off the message alone says `ok` for a live Claude
 * call the browser draws as `running`. Both callers therefore take
 * `isStreaming`, the value a `snapshot` or `status` event carries.
 */

import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AssistantTurn, PaneMessage } from "$shared/protocol.ts";
import { buildTranscript, type TranscriptEntry, type TranscriptView } from "$client/render/transcript.ts";
import { argString, editHunks, prettyArgs } from "$client/render/tools/args.ts";
import { buildDiff } from "$client/render/tools/diff.ts";
import { toolSummary } from "$client/render/tools/summary.ts";
import { oneLine, resultText, toolState, userBlocks } from "$client/render/types.ts";
import type { NodeDiffLine, NodePart, TextPart, ToolPart, TranscriptNode, TurnMeta } from "./protocol.ts";

/** Markdown source to the sanitized HTML a text part carries; `loadRenderer` in `render.ts` supplies the browser's. */
export type Render = (markdown: string) => string;

export function projectTranscript(messages: PaneMessage[], isStreaming: boolean, render: Render): TranscriptNode[] {
	const view = buildTranscript(messages);
	return view.entries.map((entry) => nodeFor(view, entry, isStreaming, render));
}

/**
 * The node an `upsert` replaces. `messages` is the transcript before the
 * upsert and is not mutated; the caller applies the same upsert to its own
 * copy. `index` may equal `messages.length` to append, as on the wire, and
 * nothing beyond: `session-state.ts` accepts the same range.
 */
export function projectUpsert(
	messages: PaneMessage[],
	index: number,
	message: PaneMessage,
	isStreaming: boolean,
	render: Render,
): TranscriptNode {
	if (!Number.isInteger(index) || index < 0 || index > messages.length) {
		throw new RangeError(`upsert index ${index} is outside a transcript of ${messages.length} messages`);
	}
	const next = messages.slice();
	next[index] = message;
	const view = buildTranscript(next);

	const owner =
		message.role === "toolResult"
			? view.entries.find(
					(entry) =>
						entry.message.role === "assistant" &&
						entry.message.content.some(
							(block) => block.type === "toolCall" && block.id === message.toolCallId,
						),
				)
			: undefined;
	// Always found: a non-result message is its own entry, and a result is
	// either folded into its owner above or kept as an orphan entry.
	const entry = owner ?? view.entries.find((candidate) => candidate.index === index)!;
	return nodeFor(view, entry, isStreaming, render);
}

function nodeFor(view: TranscriptView, entry: TranscriptEntry, isStreaming: boolean, render: Render): TranscriptNode {
	const { index, message } = entry;
	const text = (markdown: string): TextPart => ({ type: "text", text: markdown, html: render(markdown) });
	switch (message.role) {
		case "user":
			return {
				index,
				role: "user",
				parts: userBlocks(message.content).map((block) =>
					block.type === "image"
						? { type: "image", mimeType: block.mimeType, data: block.data }
						: text(block.type === "text" ? block.text : ""),
				),
			};
		case "assistant": {
			const turn = message as AssistantTurn;
			const streaming = isStreaming && index === view.lastIndex;
			const parts: NodePart[] = turn.content.map((block) => {
				if (block.type === "text") return text(block.text);
				if (block.type === "thinking") {
					return { type: "thinking", text: block.thinking, redacted: block.redacted === true };
				}
				return toolPart(block, view.results.get(block.id), streaming);
			});
			return { index, role: "assistant", parts, meta: metaFor(turn) };
		}
		case "toolResult":
			return { index, role: "tool-result", parts: [orphanPart(message)] };
		case "compactionSummary":
			return {
				index,
				role: "compactionSummary",
				parts: message.summary ? [text(message.summary)] : [],
			};
		default:
			return {
				index,
				role: String((message as { role: unknown }).role),
				parts: [text(JSON.stringify(message, null, 2))],
			};
	}
}

function toolPart(call: ToolCall, result: ToolResultMessage | undefined, streaming: boolean): ToolPart {
	const part: ToolPart = {
		type: "tool",
		name: call.name,
		summary: toolSummary(call),
		args: prettyArgs(call.arguments),
		result: resultText(result),
		state: toolState({ call, result, streaming }),
	};
	const diff = diffFor(call);
	if (diff) part.diff = diff;
	return part;
}

/**
 * For `edit`, the lines `EditTool.svelte` draws. For `write`, the whole
 * content as added lines -- the browser shows a write as plain content, not a
 * diff, but one drawer on the Emacs side then serves both.
 */
function diffFor(call: ToolCall): NodeDiffLine[] | undefined {
	const name = call.name.toLowerCase();
	if (name === "edit") {
		return editHunks(call.arguments).flatMap((hunk) => buildDiff(hunk.oldText, hunk.newText));
	}
	if (name === "write") {
		return buildDiff("", argString(call.arguments, "content", "text", "newText"));
	}
	return undefined;
}

/** What `Message.svelte` draws for a result whose call is not in the slice. */
function orphanPart(result: ToolResultMessage): ToolPart {
	const text = resultText(result);
	return {
		type: "tool",
		name: result.toolName,
		summary: oneLine(text) || "result",
		args: "",
		result: text,
		state: result.isError ? "error" : "ok",
	};
}

function metaFor(turn: AssistantTurn): TurnMeta {
	const meta: TurnMeta = {
		model: turn.model,
		usage: { totalTokens: turn.usage.totalTokens, cost: turn.usage.cost.total },
	};
	if (turn.effort) meta.effort = turn.effort;
	if (turn.stopReason === "error" || turn.stopReason === "aborted") {
		meta.stopReason = turn.stopReason;
		if (turn.stopReason === "error" && turn.errorMessage) meta.errorMessage = turn.errorMessage;
	}
	return meta;
}
