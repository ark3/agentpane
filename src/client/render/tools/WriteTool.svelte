<script lang="ts">
	/**
	 * A whole-file write. The summary carries the size, because "wrote a file"
	 * and "wrote 40 KB into a file" deserve different amounts of attention.
	 */
	import { languageFromPath } from "../markdown.ts";
	import type { ToolRenderProps } from "../types.ts";
	import { basename, resultText, toolState } from "../types.ts";
	import { argString } from "./args.ts";
	import Output from "./Output.svelte";
	import ToolCard from "./ToolCard.svelte";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const path = $derived(argString(call.arguments, "path", "file", "filePath", "file_path"));
	const content = $derived(argString(call.arguments, "content", "text", "newText"));
	const state = $derived(toolState({ call, result, streaming }));
	const output = $derived(resultText(result));

	const summary = $derived(
		[basename(path), content ? `${content.split("\n").length} lines` : ""]
			.filter(Boolean)
			.join(" · "),
	);
</script>

<ToolCard name={call.name} {summary} {state}>
	{#if path}
		<p class="path" title={path}>{path}</p>
	{/if}
	<Output text={content} language={languageFromPath(path)} />
	{#if result?.isError}
		<Output text={output} error={true} />
	{/if}
</ToolCard>

<style>
	.path {
		margin: 0;
		font-family: var(--ap-font-mono);
		font-size: var(--ap-text-xs);
		color: var(--ap-fg-subtle);
		overflow-wrap: anywhere;
	}
</style>
