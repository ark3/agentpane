<script lang="ts">
	/**
	 * Shared chrome for every tool renderer: a one-line summary that is
	 * collapsed by default (D5), with the detail behind a native `<details>`
	 * disclosure so keyboard and screen-reader behaviour comes for free.
	 *
	 * Renderers own the summary text and the body; they do not re-implement the
	 * frame. A transcript is mostly tool calls, and a screenful of expanded
	 * cards is unreadable -- the collapsed line is the primary presentation,
	 * not a degraded one.
	 */
	import type { Snippet } from "svelte";
	import type { ToolState } from "../types.ts";

	let {
		name,
		summary = "",
		state = "ok",
		open = false,
		children,
	}: {
		name: string;
		summary?: string;
		state?: ToolState;
		open?: boolean;
		children?: Snippet;
	} = $props();
</script>

<details class="tool" data-tool={name} data-state={state} {open}>
	<summary>
		<span class="chevron" aria-hidden="true">›</span>
		<span class="name">{name}</span>
		{#if summary}<span class="summary" title={summary}>{summary}</span>{/if}
		{#if state === "running"}<span class="status running">running</span>{/if}
		{#if state === "error"}<span class="status error">error</span>{/if}
	</summary>
	<div class="body">
		{@render children?.()}
	</div>
</details>

<style>
	.tool {
		border: 1px solid var(--ap-border);
		border-radius: var(--ap-radius-md);
		background: var(--ap-surface);
		font-size: var(--ap-text-sm);
		min-width: 0;
	}

	.tool[data-state="error"] {
		border-color: var(--ap-danger);
	}

	summary {
		display: flex;
		align-items: baseline;
		gap: var(--ap-space-2);
		padding: var(--ap-space-2) var(--ap-space-3);
		cursor: pointer;
		list-style: none;
		min-width: 0;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:hover .name {
		color: var(--ap-fg);
	}

	.chevron {
		flex: none;
		color: var(--ap-fg-subtle);
		transition: transform 120ms ease;
	}

	details[open] .chevron {
		transform: rotate(90deg);
	}

	.name {
		flex: none;
		font-family: var(--ap-font-mono);
		font-weight: 600;
		color: var(--ap-fg-muted);
	}

	.summary {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--ap-font-mono);
		color: var(--ap-fg-subtle);
	}

	.status {
		flex: none;
		font-size: var(--ap-text-2xs);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.status.running {
		color: var(--ap-warning);
	}

	.status.error {
		color: var(--ap-danger);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-2);
		padding: 0 var(--ap-space-3) var(--ap-space-3);
		border-top: 1px solid var(--ap-border);
		padding-top: var(--ap-space-3);
		min-width: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
</style>
