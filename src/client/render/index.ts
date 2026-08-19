/**
 * Public surface of the renderer (D5).
 *
 * A client shell needs exactly one thing from here -- `Transcript` -- plus
 * `registerToolRenderer` if it wants to teach the registry a backend-specific
 * tool. Everything else is exported because it is useful in tests.
 */

export { default as Block } from "./Block.svelte";
export { default as ImageBlock } from "./ImageBlock.svelte";
export { default as Markdown } from "./Markdown.svelte";
export { default as Message } from "./Message.svelte";
export { default as Thinking } from "./Thinking.svelte";
export { default as ToolCallBlock } from "./ToolCallBlock.svelte";
export { default as Transcript } from "./Transcript.svelte";

export { default as ToolCard } from "./tools/ToolCard.svelte";
export { default as Output } from "./tools/Output.svelte";
export { default as ResultBody } from "./tools/ResultBody.svelte";

export {
	defaultToolRenderer,
	registerToolRenderer,
	registeredToolNames,
	resolveToolRenderer,
	type ToolRenderer,
} from "./tools/registry.ts";

export { buildDiff, diffStats, type DiffLine, type DiffLineType } from "./tools/diff.ts";
export {
	highlightCode,
	languageFromPath,
	renderCode,
	renderMarkdown,
	renderMarkdownWithFences,
	sanitize,
	type Fence,
} from "./markdown.ts";
export { buildTranscript, type TranscriptEntry, type TranscriptView } from "./transcript.ts";
export { editHunks, prettyArgs, summarizeArgs, type EditHunk } from "./tools/args.ts";
export {
	isPending,
	oneLine,
	resultImages,
	resultText,
	toolState,
	userBlocks,
	type ContentBlock,
	type ToolRenderProps,
	type ToolState,
} from "./types.ts";
