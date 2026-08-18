<script lang="ts">
	/** A file read: the path is the summary, the file body is the detail. */
	import { languageFromPath } from "../markdown.ts";
	import type { ToolRenderProps } from "../types.ts";
	import { basename, toolState } from "../types.ts";
	import { argNumber, argString } from "./args.ts";
	import ResultBody from "./ResultBody.svelte";
	import ToolCard from "./ToolCard.svelte";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const path = $derived(argString(call.arguments, "path", "file", "filePath", "file_path"));
	const state = $derived(toolState({ call, result, streaming }));

	const summary = $derived.by(() => {
		const offset = argNumber(call.arguments, "offset");
		const limit = argNumber(call.arguments, "limit");
		const extras = [
			offset === undefined ? "" : `offset ${offset}`,
			limit === undefined ? "" : `limit ${limit}`,
		].filter(Boolean);
		return [basename(path), ...extras].filter(Boolean).join(" · ");
	});
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
