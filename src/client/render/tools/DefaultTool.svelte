<script lang="ts">
	/**
	 * The default tool card -- the registry's most important entry, not its
	 * fallback (D5).
	 *
	 * Codex's `mcpToolCall` and `dynamicToolCall` carry names that cannot be
	 * known ahead of time, and even Pi picks `bash` for a file edit, so an
	 * unregistered tool is the normal case rather than an error case. This card
	 * therefore has to be genuinely useful: the tool's name, a readable summary
	 * of its arguments, the full arguments, and the result.
	 */
	import type { ToolRenderProps } from "../types.ts";
	import { toolState } from "../types.ts";
	import { prettyArgs } from "./args.ts";
	import Output from "./Output.svelte";
	import ResultBody from "./ResultBody.svelte";
	import ToolCard from "./ToolCard.svelte";
	import { toolSummary } from "./summary.ts";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const state = $derived(toolState({ call, result, streaming }));
	const summary = $derived(toolSummary(call));
	const args = $derived(prettyArgs(call.arguments));
</script>

<ToolCard name={call.name} {summary} {state} timestamp={result?.timestamp}>
	{#if args}
		<Output text={args} language="json" />
	{/if}
	<ResultBody {result} />
</ToolCard>
