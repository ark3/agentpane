/**
 * Hand-built `AgentMessage[]` samples -- what the renderer is verified against
 * (WORKSTREAMS) and what a later shell workstream can point at a Transcript to
 * see it work with no server running.
 *
 * These are *modelled on* `resources/fixtures/pi/*.jsonl` rather than loaded
 * from them: Pi's `message_end` payloads already are `AgentMessage` objects, so
 * the field set here (api/provider/model/usage/stopReason/timestamp, `thinking`
 * blocks with an opaque signature and empty text, `bash` chosen to edit a file)
 * is copied from real captures. Depending on the files at test time would tie
 * these tests to fixture wording, which WORKSTREAMS forbids.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	StopReason,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";

let clock = 1786419855000;
const stamp = () => (clock += 1000);

/** A 1x1 transparent PNG, so the image paths have a real payload. */
const PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function usage(input = 12, output = 40): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: stamp() };
}

export function assistant(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "example-api-stream",
		provider: "example-provider",
		model: "example-model",
		usage: usage(),
		stopReason,
		timestamp: stamp(),
		...extra,
	};
}

export function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: stamp(),
	};
}

/** Plain prose, the simplest possible turn. */
export const textOnly: AgentMessage[] = [
	user("Reply with exactly: hello there friend"),
	assistant([{ type: "text", text: "hello there friend" }]),
];

/** Markdown exercising headings, lists, tables, inline and fenced code. */
export const richMarkdown: AgentMessage[] = [
	user("Summarise the module layout."),
	assistant([
		{
			type: "text",
			text: [
				"## Layout",
				"",
				"The renderer splits into three parts:",
				"",
				"- `Transcript` — the keyed list",
				"- `Message` — role chrome",
				"- `Block` — dispatch on `block.type`",
				"",
				"| part | owns |",
				"| --- | --- |",
				"| registry | tool name → component |",
				"| markdown | parse **and** sanitize |",
				"",
				"```ts",
				'const renderer = resolveToolRenderer("bash");',
				"```",
				"",
				"See [the design](https://example.invalid/design) for why.",
			].join("\n"),
		},
	]),
];

/**
 * Thinking, a tool call, its result, and a closing message -- the shape of
 * `resources/fixtures/pi/tool-read.jsonl`, including the empty-text thinking
 * block that only carries a signature.
 */
export const toolRead: AgentMessage[] = [
	user("Read greeting.txt and tell me, in one short sentence, what it says."),
	assistant(
		[
			{ type: "thinking", thinking: "The file is small; read it directly." },
			{ type: "thinking", thinking: "", thinkingSignature: "EugBCnEIEBABGAIqQDv" },
			{ type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "greeting.txt" } },
		],
		"toolUse",
	),
	toolResult("call_read_1", "read", "The quick brown fox jumps over the lazy dog.\n"),
	assistant([{ type: "text", text: "It says a quick brown fox jumps over a lazy dog." }]),
];

/** Pi choosing `bash` to edit a file (HANDOFF 24) -- the argument for a default card. */
export const toolBashEdit: AgentMessage[] = [
	user("Append a single line saying 'goodbye' to greeting.txt."),
	assistant(
		[
			{
				type: "toolCall",
				id: "call_bash_1",
				name: "bash",
				arguments: { command: "echo 'goodbye' >> greeting.txt && cat greeting.txt" },
			},
		],
		"toolUse",
	),
	toolResult("call_bash_1", "bash", "The quick brown fox jumps over the lazy dog.\ngoodbye\n"),
	assistant([{ type: "text", text: "Done. Appended 'goodbye' to greeting.txt." }]),
];

/**
 * A structured edit, in Pi's real argument shape.
 *
 * `{ path, edits: [{ oldText, newText }] }` -- an array, verified against the
 * tool's schema in `pi-coding-agent/dist/core/tools/edit.js`, because one call
 * may carry several disjoint replacements. The result text is Pi's real
 * wording too: the diff is not in the result at all (it is in `details`), so
 * the renderer has to build it from the arguments.
 */
export const toolEditDiff: AgentMessage[] = [
	user("Rename the greeting and its caller."),
	assistant(
		[
			{
				type: "toolCall",
				id: "call_edit_1",
				name: "edit",
				arguments: {
					path: "src/greet.ts",
					edits: [
						{
							oldText: 'export function greet() {\n\treturn "hello";\n}\n',
							newText: "export function greet(name: string) {\n\treturn `hello ${name}`;\n}\n",
						},
						{ oldText: "greet();", newText: 'greet("world");' },
					],
				},
			},
		],
		"toolUse",
	),
	toolResult("call_edit_1", "edit", "Successfully replaced 2 block(s) in src/greet.ts."),
];

/**
 * The same edit in the flat `old_string`/`new_string` shape other backends
 * use. Both have to render, which is why `editHunks` accepts either.
 */
export const toolEditFlat: AgentMessage[] = [
	user("Rename the greeting."),
	assistant(
		[
			{
				type: "toolCall",
				id: "call_edit_2",
				name: "edit",
				arguments: {
					file_path: "src/greet.ts",
					old_string: 'return "hello";',
					new_string: "return `hello ${name}`;",
				},
			},
		],
		"toolUse",
	),
	toolResult("call_edit_2", "edit", "src/greet.ts updated"),
];

/**
 * A tool result carrying an image. Pi's `read` returns exactly this shape for
 * an image path -- a short text note plus an `image` block (verified in
 * `pi-coding-agent/dist/core/tools/read.js`) -- and it is the case that a
 * text-only tool card renders as blank.
 */
export const toolReadImage: AgentMessage[] = [
	user("What is in shot.png?"),
	assistant(
		[{ type: "toolCall", id: "call_read_2", name: "read", arguments: { path: "shot.png" } }],
		"toolUse",
	),
	{
		role: "toolResult",
		toolCallId: "call_read_2",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", mimeType: "image/png", data: PIXEL_PNG },
		],
		isError: false,
		timestamp: stamp(),
	},
	assistant([{ type: "text", text: "A single transparent pixel." }]),
];

/**
 * A tool nobody registered -- Codex's `mcpToolCall` / `dynamicToolCall` carry
 * names like this, and the default card is the whole answer to them.
 */
export const unknownTool: AgentMessage[] = [
	user("What is the weather in Boston?"),
	assistant(
		[
			{
				type: "toolCall",
				id: "call_mcp_1",
				name: "weather__forecast",
				arguments: { city: "Boston", units: "metric", days: 3 },
			},
		],
		"toolUse",
	),
	toolResult("call_mcp_1", "weather__forecast", '{"today":"rain","tomorrow":"sun"}'),
];

/** Mid-turn: the tail message is `pending` and its tool call has no result yet. */
export const streamingTurn: AgentMessage[] = [
	user("Run the tests."),
	assistant(
		[
			{ type: "text", text: "Running the suite now" },
			{ type: "toolCall", id: "call_bash_2", name: "bash", arguments: { command: "bun run test" } },
		],
		"pending",
	),
];

/** A failed turn and a failed tool, the two error shapes the chrome must show. */
export const errors: AgentMessage[] = [
	user("Delete everything."),
	assistant(
		[{ type: "toolCall", id: "call_bash_3", name: "bash", arguments: { command: "rm -rf /" } }],
		"toolUse",
	),
	toolResult("call_bash_3", "bash", "rm: cannot remove '/': Permission denied", true),
	assistant([], "error", { errorMessage: "provider returned 500" }),
];

/** An orphan tool result: the call is outside this slice of the transcript. */
export const orphanResult: AgentMessage[] = [
	toolResult("call_gone", "read", "contents of a file whose call is not in this slice"),
	assistant([{ type: "text", text: "Picking up where we left off." }]),
];

/** A user message with an attached image. */
export const withImage: AgentMessage[] = [
	{
		role: "user",
		content: [
			{ type: "text", text: "What is in this screenshot?" },
			{ type: "image", mimeType: "image/png", data: PIXEL_PNG },
		],
		timestamp: stamp(),
	},
	assistant([{ type: "text", text: "A single transparent pixel." }]),
];

/** Everything at once -- the sample a shell would mount to eyeball the design. */
export const everything: AgentMessage[] = [
	...textOnly,
	...richMarkdown,
	...toolRead,
	...toolEditDiff,
	...toolReadImage,
	...unknownTool,
	...errors,
];
