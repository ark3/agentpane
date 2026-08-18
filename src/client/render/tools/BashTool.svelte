<script lang="ts">
	/**
	 * A shell command. The command itself is the summary -- it is what a reader
	 * scans a transcript for -- and the body is the command echoed above its
	 * output, the way a terminal would show it.
	 */
	import type { ToolRenderProps } from "../types.ts";
	import { oneLine, toolState } from "../types.ts";
	import { argString } from "./args.ts";
	import Output from "./Output.svelte";
	import ResultBody from "./ResultBody.svelte";
	import ToolCard from "./ToolCard.svelte";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const command = $derived(argString(call.arguments, "command", "cmd", "script"));
	const state = $derived(toolState({ call, result, streaming }));
</script>

<ToolCard name={call.name} summary={oneLine(command) || "shell"} {state} timestamp={result?.timestamp}>
	{#if command}
		<Output text={command} language="bash" />
	{/if}
	{#if result}
		<ResultBody {result} />
	{:else if state === "running"}
		<p class="pending">Running…</p>
	{/if}
</ToolCard>

<style>
	.pending {
		margin: 0;
		font-size: var(--ap-text-xs);
		color: var(--ap-fg-subtle);
	}
</style>
