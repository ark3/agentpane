<script lang="ts">
	/**
	 * An image content block. `data` is base64 and `mimeType` comes from the
	 * agent, so the mime type is checked rather than trusted: a `data:` URL
	 * with a non-image type is a script-execution vector in some contexts, and
	 * there is no reason an image block should ever carry one.
	 */
	let { data = "", mimeType = "" }: { data?: string; mimeType?: string } = $props();

	const safeType = $derived(/^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mimeType));
	const src = $derived(safeType ? `data:${mimeType};base64,${data}` : "");
</script>

{#if src}
	<img class="image" {src} alt="Attachment from the conversation" />
{:else}
	<p class="rejected">Unsupported image type{mimeType ? ` (${mimeType})` : ""}.</p>
{/if}

<style>
	.image {
		max-width: 100%;
		height: auto;
		border-radius: var(--ap-radius-md);
		border: 1px solid var(--ap-border);
	}

	.rejected {
		margin: 0;
		font-size: var(--ap-text-sm);
		color: var(--ap-fg-subtle);
	}
</style>
