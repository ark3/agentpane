<script lang="ts">
	/** A file read: the path is the summary, the file body is the detail. */
	import { languageFromPath } from "../markdown.ts";
	import type { ToolRenderProps } from "../types.ts";
	import { toolState } from "../types.ts";
	import { argString } from "./args.ts";
	import ResultBody from "./ResultBody.svelte";
	import ToolCard from "./ToolCard.svelte";
	import { toolSummary } from "./summary.ts";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const path = $derived(argString(call.arguments, "path", "file", "filePath", "file_path"));
	const state = $derived(toolState({ call, result, streaming }));

	const summary = $derived(toolSummary(call));
</script>

<ToolCard name={call.name} {summary} {state} timestamp={result?.timestamp}>
	{#if path}
		<p class="path" title={path}>{path}</p>
	{/if}
	<ResultBody {result} language={languageFromPath(path)} />
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
