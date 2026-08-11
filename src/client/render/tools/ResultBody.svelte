<script lang="ts">
	/**
	 * A tool result, rendered as the content blocks it actually is.
	 *
	 * `ToolResultMessage.content` is `(TextContent | ImageContent)[]`, and the
	 * image half is not hypothetical: Pi's `read` tool returns an `image` block
	 * whenever the path it was given is an image (verified in
	 * `pi-coding-agent/dist/core/tools/read.js`, the `mimeType` branch). Every
	 * card used to render `resultText()` alone, so reading a screenshot showed
	 * an empty card. D5 says dispatch on content blocks; this is where a tool
	 * result does it.
	 */
	import type { ToolResultMessage } from "@earendil-works/pi-ai";
	import ImageBlock from "../ImageBlock.svelte";
	import { resultImages, resultText } from "../types.ts";
	import Output from "./Output.svelte";

	let {
		result,
		language,
	}: { result?: ToolResultMessage | undefined; language?: string | undefined } = $props();

	const text = $derived(resultText(result));
	const images = $derived(resultImages(result));
</script>

{#if text}
	<Output {text} language={result?.isError ? undefined : language} error={result?.isError ?? false} />
{/if}
{#each images as image, i (i)}
	<ImageBlock data={image.data} mimeType={image.mimeType} />
{/each}
