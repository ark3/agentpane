<script lang="ts">
	/**
	 * One block, full screen (OW-63). The app's first modal, and deliberately a
	 * small one: a backdrop, a panel, a header of chrome, and the block's own
	 * renderer for the body.
	 *
	 * Three things here are load-bearing rather than taste:
	 *
	 * - **The body is real, selectable text.** It renders through the very
	 *   components the transcript uses -- so it goes through `markdown.ts`'s
	 *   sanitize choke point (D5) like everything else -- and nothing in it is
	 *   `pointer-events: none`. Drag-selection and the browser's own copy
	 *   hotkey work; the copy button is a shortcut, not the only way out.
	 * - **No dismiss on backdrop click.** A selection that starts on the text
	 *   and ends on the backdrop would otherwise be read as a dismiss, throwing
	 *   away the selection the reader just made. Closing is explicit: the X, or
	 *   Esc.
	 * - **The chrome is not in the body.** Copy-all and close sit in the header,
	 *   outside the selectable region, so neither drag-selection nor copy-all
	 *   can pick up the buttons' own text.
	 */
	import CopyButton from "./CopyButton.svelte";
	import Markdown from "./Markdown.svelte";
	import Output from "./tools/Output.svelte";

	let {
		source,
		kind = "markdown",
		language,
		label = "block",
		onclose,
	}: {
		source: string;
		/** How the block draws: prose markdown, or a monospace code body. */
		kind?: "markdown" | "code";
		language?: string | undefined;
		label?: string;
		onclose: () => void;
	} = $props();

	let panel: HTMLElement | undefined = $state();

	/**
	 * Focus moves into the panel on open and back where it was on close, so a
	 * keyboard reader is not dropped at the top of the document -- and so Esc
	 * reaches the window handler below rather than whatever had focus before.
	 */
	$effect(() => {
		const previous = document.activeElement;
		panel?.focus();
		return () => {
			if (previous instanceof HTMLElement) previous.focus();
		};
	});

	function onkeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape") return;
		event.preventDefault();
		onclose();
	}
</script>

<svelte:window {onkeydown} />

<!-- No click handler on the backdrop, on purpose. See the note above. -->
<div class="backdrop">
	<div class="panel" role="dialog" aria-modal="true" aria-label={label} tabindex="-1" bind:this={panel}>
		<header class="bar">
			<span class="title">{label}</span>
			<CopyButton {source} label="Copy all" />
			<button class="ap-action" type="button" data-close title="Close" aria-label="Close" onclick={onclose}
				>✕</button
			>
		</header>
		<div class="body" data-expanded-body>
			{#if kind === "code"}
				<!-- `limit` is the whole source: the transcript card is a preview,
				     but this is the place the reader came to see all of it. -->
				<Output text={source} {language} actions={false} limit={source.length} />
			{:else}
				<Markdown text={source} fenceActions={false} />
			{/if}
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		padding: var(--ap-space-5);
		background: rgb(0 0 0 / 45%);
	}

	.panel {
		display: flex;
		flex-direction: column;
		min-width: 0;
		margin: auto;
		width: min(100%, 64rem);
		max-height: 100%;
		border: 1px solid var(--ap-border-strong);
		border-radius: var(--ap-radius-lg);
		background: var(--ap-bg);
		box-shadow: 0 10px 40px rgb(0 0 0 / 35%);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: var(--ap-space-2);
		padding: var(--ap-space-2) var(--ap-space-3);
		border-bottom: 1px solid var(--ap-border);
	}

	.title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--ap-text-2xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ap-fg-subtle);
	}

	.body {
		min-width: 0;
		padding: var(--ap-space-4);
		overflow: auto;
	}

	/* The card caps its own height because it is a preview inside a scrolling
	   transcript; in here the panel is the scroller. */
	.body :global(.output) {
		max-height: none;
		font-size: var(--ap-text-sm);
	}
</style>
