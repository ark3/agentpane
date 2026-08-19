<script lang="ts">
	/** The transcript is a keyed list of messages. */
	import type { AgentMessage } from "@earendil-works/pi-agent-core";
	import Message from "./Message.svelte";
	import { buildTranscript, condense } from "./transcript.ts";

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

	const view = $derived(reading ? condense(buildTranscript(messages)) : buildTranscript(messages));
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

	{#if isStreaming && view.entries.length === 0}
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
</style>
