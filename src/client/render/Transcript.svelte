<script lang="ts">
	/** The transcript is a keyed list of messages. */
	import type { AgentMessage } from "@earendil-works/pi-agent-core";
	import Message from "./Message.svelte";
	import { buildTranscript } from "./transcript.ts";

	let {
		messages = [],
		isStreaming = false,
	}: { messages?: AgentMessage[]; isStreaming?: boolean } = $props();

	const view = $derived(buildTranscript(messages));
</script>

<div class="transcript" role="log" aria-busy={isStreaming}>
	{#each view.entries as entry (entry.key)}
		<Message
			message={entry.message}
			results={view.results}
			streaming={isStreaming && entry.index === view.lastIndex}
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
