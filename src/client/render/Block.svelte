<script lang="ts">
	/**
	 * Block dispatch -- the centre of D5. Everything a message can contain is
	 * one of four block types, and each role's content is just a different mix
	 * of them, so this switch is the only place that grows when a backend
	 * introduces something new.
	 */
	import type { ToolResultMessage } from "@earendil-works/pi-ai";
	import ImageBlock from "./ImageBlock.svelte";
	import Markdown from "./Markdown.svelte";
	import Thinking from "./Thinking.svelte";
	import ToolCallBlock from "./ToolCallBlock.svelte";
	import type { ContentBlock } from "./types.ts";

	let {
		block,
		results = new Map<string, ToolResultMessage>(),
		streaming = false,
	}: {
		block: ContentBlock;
		results?: Map<string, ToolResultMessage>;
		streaming?: boolean;
	} = $props();
</script>

{#if block.type === "text"}
	<Markdown text={block.text} {streaming} />
{:else if block.type === "thinking"}
	<Thinking text={block.thinking} redacted={block.redacted ?? false} {streaming} />
{:else if block.type === "toolCall"}
	<ToolCallBlock call={block} result={results.get(block.id)} {streaming} />
{:else if block.type === "image"}
	<ImageBlock data={block.data} mimeType={block.mimeType} />
{/if}
