<script lang="ts">
	/**
	 * A targeted file edit, shown as a diff. The summary carries +/- counts so
	 * the size of a change is legible without expanding it.
	 */
	import type { ToolRenderProps } from "../types.ts";
	import { basename, resultText, toolState } from "../types.ts";
	import { argString } from "./args.ts";
	import { buildDiff, diffStats } from "./diff.ts";
	import Output from "./Output.svelte";
	import ToolCard from "./ToolCard.svelte";

	let { call, result, streaming = false }: ToolRenderProps = $props();

	const path = $derived(argString(call.arguments, "path", "file", "filePath", "file_path"));
	const oldText = $derived(argString(call.arguments, "oldText", "old_string", "old_str", "search"));
	const newText = $derived(
		argString(call.arguments, "newText", "new_string", "new_str", "replace"),
	);
	const state = $derived(toolState({ call, result, streaming }));
	const output = $derived(resultText(result));

	const lines = $derived(oldText || newText ? buildDiff(oldText, newText) : []);
	const stats = $derived(diffStats(lines));
	const summary = $derived(
		[basename(path), lines.length ? `+${stats.added} −${stats.removed}` : ""]
			.filter(Boolean)
			.join(" · "),
	);
</script>

<ToolCard name={call.name} {summary} {state}>
	{#if path}
		<p class="path" title={path}>{path}</p>
	{/if}

	{#if lines.length}
		<div class="diff">
			{#each lines as line, i (i)}
				<div class="line {line.type}">
					<span class="sign" aria-hidden="true"
						>{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span
					><span class="text">{line.text}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if output}
		<Output text={output} error={result?.isError ?? false} />
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

	.diff {
		border-radius: var(--ap-radius-sm);
		background: var(--ap-bg-sunken);
		font-family: var(--ap-font-mono);
		font-size: var(--ap-text-xs);
		line-height: var(--ap-leading-normal);
		max-height: 24rem;
		overflow: auto;
		padding: var(--ap-space-2) 0;
	}

	.line {
		display: flex;
		padding: 0 var(--ap-space-2);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.sign {
		flex: none;
		width: 1.25ch;
		color: inherit;
		opacity: 0.7;
	}

	.line.add {
		background: var(--ap-add-bg);
		color: var(--ap-add-fg);
	}

	.line.del {
		background: var(--ap-del-bg);
		color: var(--ap-del-fg);
	}

	.line.ctx {
		color: var(--ap-fg-muted);
	}

	.line.gap {
		color: var(--ap-fg-subtle);
		font-style: italic;
	}
</style>
