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
	import { formatTimestamp, timestampIso } from "../../time.ts";
	import type { ToolState } from "../types.ts";

	let {
		name,
		summary = "",
		state = "ok",
		open = false,
		timestamp,
		children,
	}: {
		name: string;
		summary?: string;
		state?: ToolState;
		open?: boolean;
		/**
		 * When the result landed (OW-67), epoch-ms. Unset while the tool is still
		 * running -- there is no time to show yet. It belongs in the body, not the
		 * summary: the collapsed line is what a reader scans, and a stamp on every
		 * one of them is noise.
		 */
		timestamp?: number | undefined;
		children?: Snippet;
	} = $props();

	const time = $derived(formatTimestamp(timestamp));
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
		{#if time}
			<time class="time" datetime={timestampIso(timestamp)}>{time}</time>
		{/if}
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
		margin-left: auto;
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

	.time {
		align-self: flex-start;
		font-size: var(--ap-text-2xs);
		color: var(--ap-fg-subtle);
		font-variant-numeric: tabular-nums;
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
</style>
