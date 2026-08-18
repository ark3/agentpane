<script lang="ts">
	/**
	 * The per-block chrome (OW-63): copy and expand, side by side, acting on one
	 * block and never on a whole message.
	 *
	 * A message is an ordered mix of text / thinking / toolCall blocks, so
	 * "copy the message" would have to invent a serialization -- how do you
	 * render a tool call as text? -- and hand over something no single source
	 * ever held. The unit is the block, and `source` is the string the block's
	 * own component already holds.
	 *
	 * The overlay is rendered here, next to the button that opens it, rather
	 * than mounted once in the shell: it is `position: fixed`, so where it sits
	 * in the tree has no bearing on where it draws, and this way a block needs
	 * no store, no context and no plumbing through `App.svelte` to be
	 * expandable. Read-only, deliberately -- edit and resubmit is OW-22.
	 */
	import { formatTimestamp, timestampIso } from "../time.ts";
	import Expanded from "./Expanded.svelte";
	import CopyButton from "./CopyButton.svelte";

	let {
		source,
		kind = "markdown",
		language,
		label = "block",
		timestamp,
	}: {
		source: string;
		kind?: "markdown" | "code";
		language?: string | undefined;
		label?: string;
		/**
		 * When the message happened (OW-67), epoch-ms. A message-level fact
		 * sharing a block-level row: a user message is one text block, and this
		 * row is the only chrome it has. Unset for every other caller.
		 */
		timestamp?: number | undefined;
	} = $props();

	let expanded = $state(false);
	const time = $derived(formatTimestamp(timestamp));
</script>

<div class="actions" data-block-actions={label}>
	{#if time}
		<time class="time" datetime={timestampIso(timestamp)}>{time}</time>
	{/if}
	<CopyButton {source} label="Copy {label}" />
	<button
		class="ap-action"
		type="button"
		data-expand
		title="Expand {label}"
		aria-label="Expand {label}"
		onclick={() => (expanded = true)}>⤢</button
	>
</div>

{#if expanded}
	<Expanded {source} {kind} {language} {label} onclose={() => (expanded = false)} />
{/if}

<style>
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--ap-space-1);
		/* Chrome, not content: it must never read as part of the block it acts
		   on, and it must not add a line of space when it is quiet. */
		margin-top: calc(-1 * var(--ap-space-1));
		opacity: 0.55;
		/* Drag-selecting a block must not pick up the glyphs of the buttons that
		   copy it -- browsers leave `user-select: none` text out of a copy. */
		user-select: none;
	}

	.actions:hover,
	.actions:focus-within {
		opacity: 1;
	}

	/* The buttons stay right-aligned; the time takes the other end of the row. */
	.time {
		margin-right: auto;
		font-size: var(--ap-text-2xs);
		color: var(--ap-fg-subtle);
		font-variant-numeric: tabular-nums;
	}
</style>
