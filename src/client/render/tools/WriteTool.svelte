<script lang="ts">
	/**
	 * A whole-file write. The summary carries the size, because "wrote a file"
	 * and "wrote 40 KB into a file" deserve different amounts of attention.
	 */
	import { languageFromPath } from "../markdown.ts";
	import type { ToolRenderProps } from "../types.ts";
	import { toolState } from "../types.ts";
	import { argString } from "./args.ts";
	import Output from "./Output.svelte";
	import ResultBody from "./ResultBody.svelte";
	import ToolCard from "./ToolCard.svelte";
	import { toolSummary } from "./summary.ts";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const path = $derived(argString(call.arguments, "path", "file", "filePath", "file_path"));
	const content = $derived(argString(call.arguments, "content", "text", "newText"));
	const state = $derived(toolState({ call, result, streaming }));

	const summary = $derived(toolSummary(call));
</script>

<ToolCard name={call.name} {summary} {state} timestamp={result?.timestamp}>
	{#if path}
		<p class="path" title={path}>{path}</p>
	{/if}
	<Output text={content} language={languageFromPath(path)} />
	<!-- Only the failure is worth repeating: a successful write's result is
	     "Successfully wrote N bytes to <path>", which the card already says. -->
	{#if result?.isError}
		<ResultBody {result} />
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
