<script lang="ts">
	/** The transcript is a keyed list of messages. */
	import type { AgentMessage } from "@earendil-works/pi-agent-core";
	import Message from "./Message.svelte";
	import { buildTranscript, condense, readingTailStatus } from "./transcript.ts";

	let {
		messages = [],
		isStreaming = false,
		reading = false,
		editingIndex = null,
		onedit,
	}: {
		messages?: AgentMessage[];
		isStreaming?: boolean;
		/** Reading view (OW-51): elide tool calls, tool results and thinking. */
		reading?: boolean;
		/**
		 * Index in `messages` of the user message the composer is editing
		 * (OW-hezidi), or null. It marks that message and dims everything after
		 * it: with the whole transcript undimmed there is nothing on screen
		 * telling "this composer will fork at message 5" from "this composer will
		 * append here", and those outcomes differ by a whole session.
		 */
		editingIndex?: number | null;
		/** Offer an edit control on every user message. Omitted -- a read-only preview -- and none is drawn. */
		onedit?: ((index: number) => void) | undefined;
	} = $props();

	const fullView = $derived(buildTranscript(messages));
	const view = $derived(reading ? condense(fullView) : fullView);
	const tailStatus = $derived(reading ? readingTailStatus(fullView, isStreaming) : undefined);
</script>

<div class="transcript" role="log" aria-busy={isStreaming}>
	{#each view.entries as entry (entry.key)}
		<Message
			message={entry.message}
			results={view.results}
			streaming={isStreaming && entry.index === view.lastIndex}
			index={entry.index}
			editing={entry.index === editingIndex}
			dimmed={editingIndex !== null && entry.index > editingIndex}
			{onedit}
		/>
	{/each}

	{#if tailStatus}
		<p class="reading-tail" data-reading-tail={tailStatus.kind} role="status">
			<span class="tail-name">{tailStatus.name}</span>
			{#if tailStatus.summary}<span class="tail-summary" title={tailStatus.summary}>{tailStatus.summary}</span>{/if}
			<span class="tail-state">running</span>
		</p>
	{/if}

	{#if isStreaming && view.entries.length === 0 && !tailStatus}
		<p class="waiting">Waiting for the agent…</p>
	{/if}
	{#if !isStreaming && view.entries.length === 0}
		<p class="empty">No messages yet.</p>
	{/if}
</div>

<style>
	.transcript {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-5);
		padding: var(--ap-space-5) var(--ap-space-4);
		font-family: var(--ap-font-sans);
		font-size: var(--ap-text-md);
		line-height: var(--ap-leading-normal);
		color: var(--ap-fg);
		background: var(--ap-bg);
	}

	.waiting,
	.empty {
		margin: 0;
		color: var(--ap-fg-subtle);
		font-size: var(--ap-text-sm);
	}

	.reading-tail {
		display: flex;
		align-items: baseline;
		gap: var(--ap-space-2);
		min-width: 0;
		margin: 0;
		padding: var(--ap-space-2) var(--ap-space-3);
		border: 1px solid var(--ap-border);
		border-radius: var(--ap-radius-md);
		background: var(--ap-surface);
		font-family: var(--ap-font-mono);
		font-size: var(--ap-text-sm);
	}

	.tail-name {
		flex: none;
		font-weight: 600;
		color: var(--ap-fg-muted);
	}

	.tail-summary {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ap-fg-subtle);
	}

	.tail-state {
		flex: none;
		margin-left: auto;
		color: var(--ap-warning);
		font-family: var(--ap-font-sans);
		font-size: var(--ap-text-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
</style>
