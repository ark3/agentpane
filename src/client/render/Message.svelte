<script lang="ts">
	/**
	 * Role chrome. Everything inside a message is a content block, so this
	 * component only decides how the message *frame* looks (D5) and hands the
	 * blocks to `Block.svelte`.
	 *
	 * `PaneMessage` is `AgentMessage` with the assistant arm widened by the
	 * fields this repo adds. It is open by construction -- `AgentMessage` is
	 * `Message | CustomAgentMessages[keyof CustomAgentMessages]`, and a backend
	 * can declaration-merge new kinds in. The final `{:else}` is therefore not
	 * dead code even though today it is unreachable by type.
	 */
	import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
	import type { PaneMessage } from "$shared/protocol.ts";
	import { formatTimestamp, timestampIso } from "../time.ts";
	import Block from "./Block.svelte";
	import type { ContentBlock } from "./types.ts";
	import { oneLine, resultText } from "./types.ts";
	import Output from "./tools/Output.svelte";
	import ResultBody from "./tools/ResultBody.svelte";
	import ToolCard from "./tools/ToolCard.svelte";

	let {
		message,
		results = new Map<string, ToolResultMessage>(),
		streaming = false,
		index,
	}: {
		message: PaneMessage;
		results?: Map<string, ToolResultMessage>;
		streaming?: boolean;
		/** Position in the original `messages` array (OW-27: lets the shell find a specific message's DOM node, e.g. to anchor follow-mode). Omitted, no `data-index` renders. */
		index?: number;
	} = $props();

	/** `UserMessage.content` is `string | blocks[]`; normalise so Block handles both. */
	function userBlocks(content: string | (TextContent | ImageContent)[]): ContentBlock[] {
		return typeof content === "string" ? [{ type: "text", text: content }] : content;
	}

	const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
</script>

{#if message.role === "user"}
	<article class="msg user" data-role="user" data-index={index}>
		<div class="body">
			<!-- When the message happened is a fact about the *message*, but a user
			     message is effectively one text block, so it rides the first block's
			     action row (OW-63) rather than growing a meta row of its own. Only
			     the first block is offered it, so it can never render twice. -->
			{#each userBlocks(message.content) as block, i (i)}
				<Block {block} {results} timestamp={i === 0 ? message.timestamp : undefined} />
			{/each}
		</div>
	</article>
{:else if message.role === "assistant"}
	<article class="msg assistant" data-role="assistant" data-index={index}>
		<div class="body">
			{#each message.content as block, i (i)}
				<Block {block} {results} streaming={streaming && i === message.content.length - 1} />
			{/each}

			{#if streaming && message.content.length === 0}
				<span class="cursor" aria-label="thinking">●</span>
			{/if}
		</div>

		{#if message.stopReason === "error"}
			<p class="banner error" role="status">
				{message.errorMessage || "The turn ended in an error."}
			</p>
		{:else if message.stopReason === "aborted"}
			<p class="banner aborted" role="status">Aborted.</p>
		{/if}

		<!-- The model and the accounting are separate facts: a finished turn can
		     report no usage (a synthesised preview turn, or a provider that sends
		     none) and still know which model answered. -->
		{#if message.stopReason !== "pending" && (message.model || message.usage.totalTokens > 0)}
			{@const time = formatTimestamp(message.timestamp)}
			<p class="meta">
				<!-- Absolute and UTC, byte-identical to the session list's (OW-67):
				     the same formatter, so the two can never drift apart. -->
				{#if time}
					<time datetime={timestampIso(message.timestamp)}>{time}</time>
				{/if}
				{#if message.model}
					<span>{message.model}</span>
				{/if}
				<!-- Effort is a property of the model that answered, so it sits with
				     the model. Only Codex reports one (OW-61); absent, nothing shows. -->
				{#if message.effort}
					<span>{message.effort}</span>
				{/if}
				{#if message.usage.totalTokens > 0}
					<span>{compact.format(message.usage.totalTokens)} tok</span>
					{#if message.usage.cost.total > 0}
						<span>${message.usage.cost.total.toFixed(4)}</span>
					{/if}
				{/if}
			</p>
		{/if}
	</article>
{:else if message.role === "toolResult"}
	<!-- An orphan: the call it answers is not in this transcript slice. -->
	<article class="msg tool-result" data-role="tool-result" data-index={index}>
		<ToolCard
			name={message.toolName}
			summary={oneLine(resultText(message)) || "result"}
			state={message.isError ? "error" : "ok"}
			timestamp={message.timestamp}
		>
			<ResultBody result={message} />
		</ToolCard>
	</article>
{:else}
	<article class="msg unknown" data-role="unknown" data-index={index}>
		<Output text={JSON.stringify(message, null, 2)} language="json" />
	</article>
{/if}

<style>
	.msg {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-2);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: var(--ap-space-3);
		min-width: 0;
	}

	/* The user's own words are the landmark you scan for, so they get the one
	   filled surface in the transcript. Everything else sits on the page. */
	.user {
		align-self: flex-start;
		max-width: min(100%, 62ch);
		padding: var(--ap-space-3) var(--ap-space-4);
		background: var(--ap-surface-raised);
		border: 1px solid var(--ap-border);
		border-left: 2px solid var(--ap-accent);
		border-radius: var(--ap-radius-lg);
	}

	.banner {
		margin: 0;
		padding: var(--ap-space-2) var(--ap-space-3);
		border-radius: var(--ap-radius-md);
		font-size: var(--ap-text-sm);
	}

	.banner.error {
		background: var(--ap-danger-soft);
		color: var(--ap-danger);
	}

	.banner.aborted {
		color: var(--ap-fg-subtle);
		padding-left: 0;
	}

	.meta {
		display: flex;
		gap: var(--ap-space-3);
		margin: 0;
		font-size: var(--ap-text-2xs);
		color: var(--ap-fg-subtle);
		font-variant-numeric: tabular-nums;
	}

	.cursor {
		align-self: flex-start;
		color: var(--ap-fg-subtle);
		animation: ap-pulse 1.1s ease-in-out infinite;
	}

	@keyframes ap-pulse {
		0%,
		100% {
			opacity: 0.25;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.cursor {
			animation: none;
		}
	}
</style>
