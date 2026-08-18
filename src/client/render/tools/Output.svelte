<script lang="ts">
	/**
	 * A block of agent-produced text: command output, a file body, JSON args.
	 *
	 * Highlighted when a language is known, escaped otherwise -- and either way
	 * it goes through the same DOMPurify pass as markdown does (`renderCode`),
	 * because "highlight.js escapes its own output" is exactly the kind of
	 * assumption that stops being true one dependency upgrade later.
	 */
	import BlockActions from "../BlockActions.svelte";
	import { renderCode } from "../markdown.ts";
	import { truncate } from "../types.ts";

	let {
		text = "",
		language,
		error = false,
		/** Agents can emit megabytes; the card is a preview, not a file viewer. */
		limit = 250000,
		/** Copy/expand chrome. Off inside the expand overlay, which is already showing this text. */
		actions = true,
	}: {
		text?: string;
		language?: string | undefined;
		error?: boolean;
		limit?: number;
		actions?: boolean;
	} = $props();

	const clipped = $derived(truncate(text, limit));
	const html = $derived(renderCode(clipped, language));
</script>

{#if text}
	<pre class="output" class:error>{@html html}</pre>
	{#if text.length > limit}
		<p class="clipped">Output truncated ({text.length.toLocaleString()} characters).</p>
	{/if}
	<!-- `text`, not `clipped`: what the card shows is a preview, and a copy
	     limited to the preview would be a worse version of selecting it by hand
	     (OW-63). Expand shows all of it too. -->
	{#if actions}
		<BlockActions source={text} kind="code" {language} label="output" />
	{/if}
{/if}

<style>
	.output {
		margin: 0;
		padding: var(--ap-space-2) var(--ap-space-3);
		border-radius: var(--ap-radius-sm);
		background: var(--ap-bg-sunken);
		font-family: var(--ap-font-mono);
		font-size: var(--ap-text-xs);
		line-height: var(--ap-leading-normal);
		color: var(--ap-fg);
		max-height: 24rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.output.error {
		color: var(--ap-danger);
		background: var(--ap-danger-soft);
	}

	.clipped {
		margin: 0;
		font-size: var(--ap-text-2xs);
		color: var(--ap-fg-subtle);
	}

	/* Same token mapping as Markdown.svelte -- see the note there. */
	.output :global(.hljs-keyword),
	.output :global(.hljs-selector-tag),
	.output :global(.hljs-literal),
	.output :global(.hljs-built_in) {
		color: var(--ap-syn-keyword);
	}
	.output :global(.hljs-string),
	.output :global(.hljs-regexp) {
		color: var(--ap-syn-string);
	}
	.output :global(.hljs-number),
	.output :global(.hljs-symbol) {
		color: var(--ap-syn-number);
	}
	.output :global(.hljs-comment),
	.output :global(.hljs-quote) {
		color: var(--ap-syn-comment);
		font-style: italic;
	}
	.output :global(.hljs-title),
	.output :global(.hljs-section) {
		color: var(--ap-syn-function);
	}
	.output :global(.hljs-type),
	.output :global(.hljs-params) {
		color: var(--ap-syn-type);
	}
	.output :global(.hljs-attr),
	.output :global(.hljs-attribute),
	.output :global(.hljs-variable),
	.output :global(.hljs-meta) {
		color: var(--ap-syn-attr);
	}
</style>
