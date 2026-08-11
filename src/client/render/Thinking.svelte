<script lang="ts">
	/**
	 * A thinking block. D5: "keep thinking blocks visually recessive."
	 *
	 * Recessive here means small, muted, and collapsed -- but *open while it is
	 * streaming*, because watching the model reason is the only time it is
	 * worth screen space. It closes itself when the turn settles, unless the
	 * reader has taken manual control of the disclosure.
	 */
	import Markdown from "./Markdown.svelte";
	import { oneLine } from "./types.ts";

	let {
		text = "",
		redacted = false,
		streaming = false,
	}: { text?: string; redacted?: boolean; streaming?: boolean } = $props();

	/** null = still following `streaming`; a boolean = the reader decided. */
	let manual: boolean | null = $state(null);
	const open = $derived(manual ?? streaming);

	/**
	 * `toggle` fires for *programmatic* changes too -- the spec queues it
	 * whenever the `open` attribute changes state, no matter who changed it,
	 * and jsdom implements that faithfully (verified: setting `open` on a
	 * detached <details> delivers a toggle event). So auto-opening on
	 * `streaming` immediately echoed back as "the reader opened it", latching
	 * `manual` to true and leaving every thinking block on screen expanded
	 * forever. Ignore the echo: only a state that disagrees with what we asked
	 * for can have come from the reader.
	 */
	function readerToggled(event: Event): boolean {
		return (event.currentTarget as HTMLDetailsElement).open !== open;
	}

	const preview = $derived(oneLine(text, 80));

	/**
	 * Pi emits thinking blocks whose text is empty and whose payload is an
	 * opaque `thinkingSignature` (see resources/fixtures/pi/tool-read.jsonl).
	 * There is nothing to show and a "Thinking" row with an empty body is
	 * worse than silence -- unless it was explicitly redacted, which is worth
	 * saying once.
	 */
	const hidden = $derived(!text && !streaming && !redacted);

	function ontoggle(event: Event): void {
		if (!readerToggled(event)) return;
		manual = (event.currentTarget as HTMLDetailsElement).open;
	}
</script>

{#if !hidden}
	<details class="thinking" {open} {ontoggle} data-block="thinking">
		<summary>
			<span class="label">Thinking</span>
			{#if preview}<span class="preview">{preview}</span>{/if}
			{#if redacted}<span class="preview">redacted by the provider</span>{/if}
		</summary>
		<div class="body">
			{#if text}
				<Markdown {text} {streaming} />
			{:else if redacted}
				<p class="note">The provider withheld this reasoning.</p>
			{/if}
		</div>
	</details>
{/if}

<style>
	.thinking {
		font-size: var(--ap-text-sm);
		color: var(--ap-fg-muted);
	}

	summary {
		display: flex;
		gap: var(--ap-space-2);
		align-items: baseline;
		cursor: pointer;
		list-style: none;
		color: var(--ap-fg-subtle);
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.label {
		font-size: var(--ap-text-2xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		flex: none;
	}

	.label::before {
		content: "›";
		display: inline-block;
		margin-right: var(--ap-space-1);
		transition: transform 120ms ease;
	}

	details[open] .label::before {
		transform: rotate(90deg);
	}

	.preview {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-style: italic;
	}

	.body {
		margin-top: var(--ap-space-2);
		padding-left: var(--ap-space-3);
		border-left: 1px solid var(--ap-border);
		color: var(--ap-fg-muted);
	}

	.note {
		margin: 0;
		font-style: italic;
	}

	@media (prefers-reduced-motion: reduce) {
		.label::before {
			transition: none;
		}
	}
</style>
